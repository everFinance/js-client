import { createData, DataItem } from "arseeding-arbundles";
import { AxiosResponse } from "axios";
import Utils from "./utils"
import Api from "./api";
import { Currency, Manifest } from "./types";
import PromisePool from "@supercharge/promise-pool/dist";
import retry from "async-retry";
import Crypto from "crypto"
import { Readable } from "stream";
import chunker from "./chunker"
import S2A from "./s2ai"


export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

// eslint-disable-next-line @typescript-eslint/naming-convention
export default class Uploader {
    protected readonly api: Api
    protected currency: string;
    protected currencyConfig: Currency;
    protected utils: Utils
    protected contentTypeOverride: string
    protected forceUseChunking: boolean

    constructor(api: Api, utils: Utils, currency: string, currencyConfig: Currency) {
        this.api = api;
        this.currency = currency;
        this.currencyConfig = currencyConfig;
        this.utils = utils;
    }


    /**
     * Uploads data to the bundler
     * @param data
     * @param tags
     * @returns the response from the bundler
     */
    public async upload(data: Buffer, tags?: { name: string, value: string }[]): Promise<AxiosResponse<any>> {

        const signer = await this.currencyConfig.getSigner();
        const dataItem = createData(
            data,
            signer,
            { tags, anchor: Crypto.randomBytes(32).toString("base64").slice(0, 32) }
        );
        await dataItem.sign(signer);
        return await this.transactionUploader(dataItem);
    }


    /**
     * Uploads a given transaction to the bundler
     * @param transaction
     */
    public async transactionUploader(transaction: DataItem): Promise<AxiosResponse<any>> {
        let res: AxiosResponse<any>
        const length = transaction.getRaw().byteLength
        if (this.forceUseChunking || length > 50_000_000) {
            res = await this.chunkedTransactionUploader(transaction.getRaw(), transaction.id, length)
        } else {
            const { protocol, host, port, timeout } = this.api.getConfig();
            res = await this.api.post(`${protocol}://${host}:${port}/tx/${this.currency}`, transaction.getRaw(), {
                headers: { "Content-Type": "application/octet-stream" },
                timeout,
                maxBodyLength: Infinity
            })
        }
        switch (res.status) {
            case 201:
                res.data = { id: transaction.id }
                return res;
            case 402:
                throw new Error("Not enough funds to send data")
            default:
                if (res.status >= 400) {
                    throw new Error(`whilst uploading DataItem: ${res.status} ${res.statusText}`)
                }
        }
        return res;
    }




    public async concurrentUploader(data: (DataItem | Buffer | string)[], concurrency = 5, resultProcessor?: (res: any) => Promise<any>, logFunction?: (log: string) => Promise<any>): Promise<{ errors: Array<any>, results: Array<any> }> {
        const errors = []
        const results = await PromisePool
            .for(data)
            .withConcurrency(concurrency >= 1 ? concurrency : 5)
            .handleError(async (error, _) => {
                errors.push(error)
                if (error.message === "Not enough funds to send data") {
                    throw error;
                }
            })
            .process(async (item, i, _) => {
                await retry(
                    async (bail) => {
                        try {
                            const res = await this.processItem(item)
                            if (i % concurrency == 0) {
                                await logFunction(`Processed ${i} Items`)
                            }
                            if (resultProcessor) {
                                return await resultProcessor({ item, res, i })
                            } else {
                                return { item, res, i }
                            }
                        } catch (e) {
                            if (e.message === "Not enough funds to send data") {
                                bail(e)
                            }
                            throw e
                        }
                    },
                    { retries: 3, minTimeout: 1000, maxTimeout: 10_000 }
                );

            }) as any
        return { errors, results: results.results }
    }

    protected async processItem(item: string | Buffer | DataItem): Promise<any> {
        if (typeof item === "string") {
            item = Buffer.from(item)
        }
        if (Buffer.isBuffer(item)) {
            const signer = await this.currencyConfig.getSigner();
            item = createData(item, signer, { anchor: Crypto.randomBytes(32).toString("base64").slice(0, 32) })
            await item.sign(signer)
        }
        return await this.transactionUploader(item);
    }

    /**
     * geneates a manifest JSON object 
     * @param config.items mapping of logical paths to item IDs
     * @param config.indexFile optional logical path of the index file for the manifest 
     * @returns 
     */
    public async generateManifest(config: { items: Map<string, string>, indexFile?: string }): Promise<Manifest> {
        const { items, indexFile } = config
        const manifest = {
            manifest: "arweave/paths",
            version: "0.1.0",
            paths: {}
        }
        if (indexFile) {

            if (!items.has(indexFile)) {
                throw new Error(`Unable to access item: ${indexFile}`)
            }
            manifest["index"] = { path: indexFile };
        }
        for (const [k, v] of items.entries()) {
            manifest.paths[k] = { id: v }
        }
        return manifest

    }



    /**
     * Chunking data uploader
     * @param dataStream - Readble of a pre-signed dataItem
     * @param id - the ID of the dataItem
     * @param size - the size of the dataItem
     * @param chunkSize - optional size to chunk the file - min 100_000, max 190_000_000 (in bytes)
     * @param batchSize - number of chunks to concurrently upload
     */
    public async chunkedTransactionUploader(dataStream: Readable | Buffer, id: string, size: number, chunkSize = 25_000_000, batchSize = 5,): Promise<any> {

        if (chunkSize < 1_000_000 || chunkSize > 190_000_000) {
            throw new Error("Invalid chunk size - must be betweem 100,000 and 190,000,000 bytes")
        }
        if (batchSize < 1) {
            throw new Error("batch size too small! must be >=1")
        }
        const promiseFactory = (d: Buffer, o: number): Promise<Record<string, any>> => {
            return new Promise((r) => {
                retry(
                    async () => {
                        await this.api.post(`/chunks/${this.currency}/${id}/${o}`, d, {
                            headers: { "Content-Type": "application/octet-stream" },
                            maxBodyLength: Infinity, // 
                            maxContentLength: Infinity,
                        }).then(re => r({ o, d: re }))
                    }
                ),
                    { retries: 3, minTimeout: 1000, maxTimeout: 10_000 }
            })
        }
        const getres = await this.api.get(`/chunks/${this.currency}/${id}/${size}`)
        if (getres.status == 201) {
            getres.data = { id }
            return getres
        }
        Utils.checkAndThrow(getres, "Getting chunk info")
        const present = getres.data.map(v => +v) as Array<number>

        const remainder = size % chunkSize;
        const chunks = (size - remainder) / chunkSize;

        const missing = [];
        for (let i = 0; i < chunks + 1; i++) {
            const s = i * chunkSize
            if (!present.includes(s)) {
                missing.push(s);
            }
        }
        // console.log(missing);

        let offset = 0;
        let processing = []

        // const ckr = new chunker({ size: chunkSize, nopad: true })
        // const ckr = new chunker({
        //     chunkSize: chunkSize,
        //     flushTail: true
        // })
        const ckr = new chunker({ chunkSize, flushTail: true })

        if (Buffer.isBuffer(dataStream)) {
            ckr.write(dataStream)
            ckr.end()
        } else {
            dataStream.pipe(ckr)
        }


        for await (const cnk of new S2A(ckr)) {

            const chunk: { id: number, data: Buffer } = cnk as any


            const data = chunk.data
            if (processing.length == batchSize) {
                await Promise.all(processing)
                processing = []
            }

            // console.log(`posting chunk ${id} - ${offset} (${offset + data.length})`)

            if (missing.includes(offset)) {
                processing.push(promiseFactory(data, offset))
            }
            offset += data.length
        }

        await Promise.all(processing);
        const finishUpload = await this.api.post(`/chunks/${this.currency}/${id}/-1`, null, {
            headers: { "Content-Type": "application/octet-stream" },
            timeout: this.api.config.timeout * 10 // server side reconstruction can take a while
        })
        if (finishUpload.status === 402) {
            throw new Error("Not enough funds to send data")
        }
        // this will throw if the dataItem reconstruction fails
        await Utils.checkAndThrow(finishUpload, "Finalising upload", [201])
        return finishUpload
    }

    set useChunking(state: boolean) {
        if (typeof state === "boolean") {
            this.forceUseChunking = state
        }
    }

    set contentType(type: string) {
        // const fullType = mime.contentType(type)
        // if(!fullType){
        //     throw new Error("Invali")
        // }
        this.contentTypeOverride = type;
    }
}

