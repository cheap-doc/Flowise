import { z } from 'zod/v3'
import { DynamicStructuredTool } from '../OpenAPIToolkit/core'
import { TOOL_ARGS_PREFIX, formatToolError } from '../../../src/agents'
import { secureFetch } from '../../../src/httpSecurity'

export const DOC_CHEAP_BASE_URL = 'https://api.doc.cheap'

export interface DocCheapToolArgs {
    apiKey: string
    actions: string[]
    returnPortrait?: boolean
    retainHours?: number
    baseUrl?: string
}

interface DocCheapRequest {
    method: 'GET' | 'POST'
    path: string
    body?: Record<string, any>
}

/**
 * Turns the API's error body `{ error: { code, message } }` into one readable line,
 * falling back to the raw text when the body is not the documented shape.
 */
export const formatApiError = (status: number, text: string): string => {
    try {
        const parsed = JSON.parse(text)
        const error = parsed?.error
        if (error && typeof error.code === 'string' && typeof error.message === 'string') {
            const docs = typeof error.docs_url === 'string' ? ` (${error.docs_url})` : ''
            return `doc.cheap API error ${status} ${error.code}: ${error.message}${docs}`
        }
    } catch {
        // not JSON; the raw text is reported below
    }
    return `doc.cheap API error ${status}: ${text}`
}

/**
 * The API takes plain base64. Accepts a data URL too and strips its prefix and any whitespace.
 */
export const toPlainBase64 = (value: string): string => {
    const trimmed = value.trim()
    const comma = trimmed.startsWith('data:') ? trimmed.indexOf(',') : -1
    return (comma >= 0 ? trimmed.slice(comma + 1) : trimmed).replace(/\s+/g, '')
}

class BaseDocCheapTool extends DynamicStructuredTool {
    protected apiKey: string
    protected apiBaseUrl: string

    constructor(args: any) {
        super(args)
        this.apiKey = args.apiKey ?? ''
        this.apiBaseUrl = (args.apiBaseUrl ?? DOC_CHEAP_BASE_URL).replace(/\/+$/, '')
    }

    async request({ method, path, body }: DocCheapRequest): Promise<string> {
        const response = await secureFetch(`${this.apiBaseUrl}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${this.apiKey}`,
                Accept: 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            body: body ? JSON.stringify(body) : undefined
        })
        const text = await response.text()
        if (!response.ok) {
            throw new Error(formatApiError(response.status, text))
        }
        return text
    }
}

const ScanDocumentSchema = z.object({
    imageUrl: z
        .string()
        .optional()
        .describe('Public http(s) URL of a JPEG or PNG image of the document. Give either imageUrl or imageBase64.'),
    imageBase64: z
        .string()
        .optional()
        .describe('The JPEG or PNG image as base64 (a data URL is accepted). Give either imageUrl or imageBase64.'),
    expectCountry: z
        .string()
        .optional()
        .describe('Optional ISO 3166-1 alpha-3 code of the country the document is expected to be from, e.g. GBR'),
    reference: z.string().optional().describe('Optional own correlation string (1 to 128 characters), echoed back in the result')
})

class ScanDocumentTool extends BaseDocCheapTool {
    returnPortrait: boolean
    retainHours?: number

    constructor(args: any) {
        super({
            name: 'doc_cheap_scan_document',
            description:
                'Read a passport, ID card or driving licence image into structured fields (names, document number, dates, MRZ). The result has a status: recognized, no_document_found, unreadable, unsupported_document or rejected.',
            schema: ScanDocumentSchema,
            baseUrl: '',
            method: 'POST',
            headers: {},
            ...args
        })
        this.returnPortrait = args.returnPortrait ?? false
        this.retainHours = args.retainHours
    }

    async loadImage(params: z.infer<typeof ScanDocumentSchema>): Promise<string> {
        if (params.imageBase64) return toPlainBase64(params.imageBase64)
        if (!params.imageUrl) throw new Error('Give either imageUrl or imageBase64')
        const response = await secureFetch(params.imageUrl, { method: 'GET' })
        if (!response.ok) {
            throw new Error(`Could not download the image: HTTP ${response.status}`)
        }
        const bytes = Buffer.from(await response.arrayBuffer())
        return bytes.toString('base64')
    }

    async _call(arg: any): Promise<string> {
        const params = arg as z.infer<typeof ScanDocumentSchema>
        // The image itself is never echoed back into the conversation.
        const loggedParams = { ...params, imageBase64: params.imageBase64 ? '[base64 image]' : undefined }
        try {
            const image = await this.loadImage(params)
            const options: Record<string, any> = { return_portrait: this.returnPortrait }
            if (params.expectCountry) options.expect_country = params.expectCountry.toUpperCase()
            if (this.retainHours !== undefined) options.retain_hours = this.retainHours
            const body: Record<string, any> = { image, options }
            if (params.reference) body.reference = params.reference
            const result = await this.request({ method: 'POST', path: '/v1/scans', body })
            return result + TOOL_ARGS_PREFIX + JSON.stringify(loggedParams)
        } catch (error) {
            return formatToolError(`Error scanning document: ${error instanceof Error ? error.message : error}`, loggedParams)
        }
    }
}

const GetScanSchema = z.object({
    id: z.string().describe('The scan id returned by doc_cheap_scan_document')
})

class GetScanTool extends BaseDocCheapTool {
    constructor(args: any) {
        super({
            name: 'doc_cheap_get_scan',
            description:
                'Read back a stored doc.cheap scan result by its id. Only scans run with a live key and kept by retention are stored.',
            schema: GetScanSchema,
            baseUrl: '',
            method: 'GET',
            headers: {},
            ...args
        })
    }

    async _call(arg: any): Promise<string> {
        const params = arg as z.infer<typeof GetScanSchema>
        try {
            const result = await this.request({ method: 'GET', path: `/v1/scans/${encodeURIComponent(params.id)}` })
            return result + TOOL_ARGS_PREFIX + JSON.stringify(params)
        } catch (error) {
            return formatToolError(`Error getting scan: ${error instanceof Error ? error.message : error}`, params)
        }
    }
}

const ListScansSchema = z.object({
    limit: z.number().int().min(1).max(100).optional().describe('How many scans to return, 1 to 100'),
    cursor: z.string().optional().describe('The next_cursor value of a previous page')
})

class ListScansTool extends BaseDocCheapTool {
    constructor(args: any) {
        super({
            name: 'doc_cheap_list_scans',
            description: 'List stored doc.cheap scan results, newest first, one page at a time.',
            schema: ListScansSchema,
            baseUrl: '',
            method: 'GET',
            headers: {},
            ...args
        })
    }

    async _call(arg: any): Promise<string> {
        const params = arg as z.infer<typeof ListScansSchema>
        try {
            const query = new URLSearchParams()
            if (params.limit) query.append('limit', String(params.limit))
            if (params.cursor) query.append('cursor', params.cursor)
            const suffix = query.toString() ? `?${query.toString()}` : ''
            const result = await this.request({ method: 'GET', path: `/v1/scans${suffix}` })
            return result + TOOL_ARGS_PREFIX + JSON.stringify(params)
        } catch (error) {
            return formatToolError(`Error listing scans: ${error instanceof Error ? error.message : error}`, params)
        }
    }
}

class GetUsageTool extends BaseDocCheapTool {
    constructor(args: any) {
        super({
            name: 'doc_cheap_get_usage',
            description: 'Get the doc.cheap account balance and usage. Costs nothing.',
            schema: z.object({}),
            baseUrl: '',
            method: 'GET',
            headers: {},
            ...args
        })
    }

    async _call(arg: any): Promise<string> {
        try {
            const result = await this.request({ method: 'GET', path: '/v1/usage' })
            return result + TOOL_ARGS_PREFIX + JSON.stringify(arg ?? {})
        } catch (error) {
            return formatToolError(`Error getting usage: ${error instanceof Error ? error.message : error}`, arg ?? {})
        }
    }
}

export const createDocCheapTools = (args: DocCheapToolArgs): DynamicStructuredTool[] => {
    const common = { apiKey: args.apiKey, apiBaseUrl: args.baseUrl ?? DOC_CHEAP_BASE_URL }
    const tools: DynamicStructuredTool[] = []
    if (args.actions.includes('scanDocument')) {
        tools.push(new ScanDocumentTool({ ...common, returnPortrait: args.returnPortrait, retainHours: args.retainHours }))
    }
    if (args.actions.includes('getScan')) tools.push(new GetScanTool(common))
    if (args.actions.includes('listScans')) tools.push(new ListScansTool(common))
    if (args.actions.includes('getUsage')) tools.push(new GetUsageTool(common))
    return tools
}
