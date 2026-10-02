import { convertMultiOptionsToStringArray, getCredentialData, getCredentialParam } from '../../../src/utils'
import { createDocCheapTools } from './core'
import type { ICommonObject, INode, INodeData, INodeParams } from '../../../src/Interface'

class DocCheap_Tools implements INode {
    label: string
    name: string
    version: number
    type: string
    icon: string
    category: string
    description: string
    baseClasses: string[]
    credential: INodeParams
    inputs: INodeParams[]

    constructor() {
        this.label = 'doc.cheap'
        this.name = 'docCheapTool'
        this.version = 1.0
        this.type = 'DocCheap'
        this.icon = 'doccheap.svg'
        this.category = 'Tools'
        this.description = 'Read a passport, ID card or driving licence image into structured fields with the doc.cheap API'
        this.baseClasses = [this.type, 'Tool']
        this.credential = {
            label: 'Connect Credential',
            name: 'credential',
            type: 'credential',
            credentialNames: ['docCheapApi']
        }
        this.inputs = [
            {
                label: 'Actions',
                name: 'actions',
                type: 'multiOptions',
                options: [
                    {
                        label: 'Scan Document',
                        name: 'scanDocument',
                        description: 'Read a document image from a URL or base64'
                    },
                    {
                        label: 'Get Scan',
                        name: 'getScan',
                        description: 'Read back a stored scan result by id'
                    },
                    {
                        label: 'List Scans',
                        name: 'listScans',
                        description: 'List stored scan results'
                    },
                    {
                        label: 'Get Usage',
                        name: 'getUsage',
                        description: 'Get the account balance and usage'
                    }
                ]
            },
            {
                label: 'Return Portrait',
                name: 'returnPortrait',
                type: 'boolean',
                description: "Include the holder's photo crop (base64) in scan results. Off by default to keep tool output small.",
                default: false,
                optional: true,
                additionalParams: true
            },
            {
                label: 'Retain Hours',
                name: 'retainHours',
                type: 'number',
                description:
                    "How many hours a scan result stays readable through Get Scan (0 to 8760; 0 stores nothing). Leave empty to use the account's own setting.",
                optional: true,
                additionalParams: true
            }
        ]
    }

    async init(nodeData: INodeData, _: string, options: ICommonObject): Promise<any> {
        const credentialData = await getCredentialData(nodeData.credential ?? '', options)
        const apiKey = getCredentialParam('docCheapApiKey', credentialData, nodeData)
        if (!apiKey) {
            throw new Error('No doc.cheap API key provided')
        }

        const actionsInput = nodeData.inputs?.actions
        const actions: string[] = Array.isArray(actionsInput) ? actionsInput : convertMultiOptionsToStringArray(actionsInput)
        if (actions.length === 0) {
            throw new Error('Select at least one doc.cheap action')
        }

        const returnPortrait = nodeData.inputs?.returnPortrait === true || nodeData.inputs?.returnPortrait === 'true'
        const retainInput = nodeData.inputs?.retainHours
        let retainHours: number | undefined
        if (retainInput !== undefined && retainInput !== null && retainInput !== '') {
            retainHours = Number(retainInput)
            if (!Number.isInteger(retainHours) || retainHours < 0 || retainHours > 8760) {
                throw new Error('Retain Hours must be a whole number from 0 to 8760')
            }
        }

        return createDocCheapTools({ apiKey, actions, returnPortrait, retainHours })
    }
}

module.exports = { nodeClass: DocCheap_Tools }
