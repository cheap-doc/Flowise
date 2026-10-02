import { INodeParams, INodeCredential } from '../src/Interface'

class DocCheapApi implements INodeCredential {
    label: string
    name: string
    version: number
    description: string
    inputs: INodeParams[]

    constructor() {
        this.label = 'doc.cheap API'
        this.name = 'docCheapApi'
        this.version = 1.0
        this.description =
            'A live key (sk_live_...) from the doc.cheap cabinet, or the public sandbox key sk_sandbox_public to try the tool without an account. See <a target="_blank" href="https://doc.cheap/docs/concepts/api-keys-and-sessions">API keys</a>.'
        this.inputs = [
            {
                label: 'API Key',
                name: 'docCheapApiKey',
                type: 'password',
                placeholder: 'sk_live_...'
            }
        ]
    }
}

module.exports = { credClass: DocCheapApi }
