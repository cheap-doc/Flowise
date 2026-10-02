import { INodeData } from '../../../src/Interface'

jest.mock('../../../src/httpSecurity', () => ({
    secureFetch: jest.fn()
}))

jest.mock('../../../src/utils', () => ({
    getCredentialData: jest.fn(async () => ({ docCheapApiKey: 'sk_sandbox_public' })),
    getCredentialParam: jest.fn((name: string, credentialData: any) => credentialData[name]),
    convertMultiOptionsToStringArray: jest.fn((value: string) => {
        try {
            return JSON.parse(value)
        } catch {
            return []
        }
    }),
    getBaseClasses: jest.fn(() => ['Tool', 'StructuredTool'])
}))

const { nodeClass: DocCheap_Tools } = require('./DocCheap')
const { secureFetch } = require('../../../src/httpSecurity')
const { formatApiError, toPlainBase64 } = require('./core')

const TOOL_ARGS_SEPARATOR = '----FLOWISE_TOOL_ARGS----'

function createNodeData(inputs: any): INodeData {
    return {
        id: 'doccheap-1',
        label: 'doc.cheap',
        name: 'docCheapTool',
        type: 'DocCheap',
        icon: 'doccheap.svg',
        version: 1.0,
        category: 'Tools',
        baseClasses: ['DocCheap', 'Tool'],
        credential: 'cred-1',
        inputs
    }
}

function jsonResponse(status: number, body: any) {
    const text = JSON.stringify(body)
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer
    }
}

const allActions = JSON.stringify(['scanDocument', 'getScan', 'listScans', 'getUsage'])

describe('DocCheap tools', () => {
    let node: any

    beforeEach(() => {
        node = new DocCheap_Tools()
        ;(secureFetch as jest.Mock).mockReset()
    })

    it('creates one tool per selected action', async () => {
        const tools = await node.init(createNodeData({ actions: allActions }), '', {})
        expect(tools.map((t: any) => t.name)).toEqual([
            'doc_cheap_scan_document',
            'doc_cheap_get_scan',
            'doc_cheap_list_scans',
            'doc_cheap_get_usage'
        ])
    })

    it('accepts actions given as an array', async () => {
        const tools = await node.init(createNodeData({ actions: ['getUsage'] }), '', {})
        expect(tools.map((t: any) => t.name)).toEqual(['doc_cheap_get_usage'])
    })

    it('refuses an empty action list and an out-of-range retention', async () => {
        await expect(node.init(createNodeData({ actions: '[]' }), '', {})).rejects.toThrow('Select at least one')
        await expect(node.init(createNodeData({ actions: allActions, retainHours: 9000 }), '', {})).rejects.toThrow('Retain Hours')
    })

    it('downloads an image URL and posts plain base64 with the bearer key', async () => {
        const png = Buffer.from('fake-png-bytes')
        ;(secureFetch as jest.Mock)
            .mockResolvedValueOnce({ ok: true, status: 200, arrayBuffer: async () => png })
            .mockResolvedValueOnce(jsonResponse(200, { id: 'scan-1', status: 'no_document_found', billed: false }))
        const [scan] = await node.init(createNodeData({ actions: '["scanDocument"]', retainHours: '0' }), '', {})

        const out = await scan._call({ imageUrl: 'https://example.com/a.png', expectCountry: 'gbr', reference: 'order-1' })

        expect(out).toContain('"status":"no_document_found"')
        const [url, init] = (secureFetch as jest.Mock).mock.calls[1]
        expect(url).toBe('https://api.doc.cheap/v1/scans')
        expect(init.method).toBe('POST')
        expect(init.headers.Authorization).toBe('Bearer sk_sandbox_public')
        expect(JSON.parse(init.body)).toEqual({
            image: png.toString('base64'),
            options: { return_portrait: false, expect_country: 'GBR', retain_hours: 0 },
            reference: 'order-1'
        })
    })

    it('strips a data URL prefix and never echoes the image back', async () => {
        ;(secureFetch as jest.Mock).mockResolvedValueOnce(jsonResponse(200, { id: 'scan-2', status: 'recognized' }))
        const [scan] = await node.init(createNodeData({ actions: '["scanDocument"]', returnPortrait: true }), '', {})

        const out = await scan._call({ imageBase64: 'data:image/png;base64,QUJD\nREVG' })

        const body = JSON.parse((secureFetch as jest.Mock).mock.calls[0][1].body)
        expect(body.image).toBe('QUJDREVG')
        expect(body.options).toEqual({ return_portrait: true })
        expect(out.split(TOOL_ARGS_SEPARATOR)[1]).not.toContain('QUJD')
    })

    it('reports a missing image without calling the API', async () => {
        const [scan] = await node.init(createNodeData({ actions: '["scanDocument"]' }), '', {})
        const out = await scan._call({})
        expect(out).toContain('Give either imageUrl or imageBase64')
        expect(secureFetch).not.toHaveBeenCalled()
    })

    it('turns the API error body into a readable message', async () => {
        ;(secureFetch as jest.Mock).mockResolvedValueOnce(
            jsonResponse(404, { error: { code: 'not_found', message: 'No scan with this id.', docs_url: 'https://doc.cheap/docs' } })
        )
        const [getScan] = await node.init(createNodeData({ actions: '["getScan"]' }), '', {})
        const out = await getScan._call({ id: 'a/b' })
        expect((secureFetch as jest.Mock).mock.calls[0][0]).toBe('https://api.doc.cheap/v1/scans/a%2Fb')
        expect(out).toContain('doc.cheap API error 404 not_found: No scan with this id. (https://doc.cheap/docs)')
    })

    it('passes list paging parameters and reads usage', async () => {
        ;(secureFetch as jest.Mock)
            .mockResolvedValueOnce(jsonResponse(200, { scans: [], next_cursor: null }))
            .mockResolvedValueOnce(jsonResponse(200, { balance: 0 }))
        const [list, usage] = await node.init(createNodeData({ actions: '["listScans","getUsage"]' }), '', {})
        await list._call({ limit: 5, cursor: 'c1' })
        await usage._call({})
        expect((secureFetch as jest.Mock).mock.calls[0][0]).toBe('https://api.doc.cheap/v1/scans?limit=5&cursor=c1')
        expect((secureFetch as jest.Mock).mock.calls[1][0]).toBe('https://api.doc.cheap/v1/usage')
    })

    it('formats non-JSON errors and plain base64 helpers', () => {
        expect(formatApiError(502, 'Bad gateway')).toBe('doc.cheap API error 502: Bad gateway')
        expect(toPlainBase64('  QUJD  ')).toBe('QUJD')
    })
})
