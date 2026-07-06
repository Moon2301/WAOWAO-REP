export type StorageType = 'minio' | 'local' | 'cos'

export interface UploadObjectParams {
  key: string
  body: Buffer
  contentType?: string
}

export interface UploadObjectResult {
  key: string
}

export interface DeleteObjectsResult {
  success: number
  failed: number
}

export interface SignedUrlParams {
  key: string
  expiresInSeconds: number
}

export interface ObjectStreamParams {
  key: string
  /** HTTP Range header value, ví dụ "bytes=0-1023" */
  range?: string
}

export interface ObjectStreamResult {
  body: ReadableStream<Uint8Array>
  status: 200 | 206
  contentType?: string
  contentLength?: number
  contentRange?: string
}

export interface StorageProvider {
  readonly kind: StorageType
  uploadObject(params: UploadObjectParams): Promise<UploadObjectResult>
  deleteObject(key: string): Promise<void>
  deleteObjects(keys: string[]): Promise<DeleteObjectsResult>
  getSignedObjectUrl(params: SignedUrlParams): Promise<string>
  getObjectBuffer(key: string): Promise<Buffer>
  /**
   * Stream object trực tiếp từ storage (hỗ trợ Range).
   * Tránh redirect browser sang endpoint nội bộ (http://minio:9000)
   * và tránh app tự fetch chính nó qua HTTP.
   */
  getObjectStream(params: ObjectStreamParams): Promise<ObjectStreamResult>
  extractStorageKey(input: string | null | undefined): string | null
  toFetchableUrl(inputUrl: string): string
  generateUniqueKey(params: { prefix: string; ext: string }): string
}

export interface StorageFactoryOptions {
  storageType?: string
}
