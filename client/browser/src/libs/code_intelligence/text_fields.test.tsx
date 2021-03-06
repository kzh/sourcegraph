const RENDER = jest.fn()
jest.mock('react-dom', () => ({
    createPortal: jest.fn(el => el),
    render: RENDER,
    unmountComponentAtNode: jest.fn(),
}))

import { uniqueId } from 'lodash'
import { from, NEVER, of, Subscription } from 'rxjs'
import { skip, take } from 'rxjs/operators'
import { Services } from '../../../../../shared/src/api/client/services'
import { CodeEditor } from '../../../../../shared/src/api/client/services/editorService'
import { integrationTestContext } from '../../../../../shared/src/api/integration-test/testHelpers'
import { Controller } from '../../../../../shared/src/extensions/controller'
import { handleTextFields } from './text_fields'

jest.mock('uuid', () => ({
    v4: () => 'uuid',
}))

const createMockController = (services: Services): Controller => ({
    services,
    notifications: NEVER,
    executeCommand: jest.fn(),
    unsubscribe: jest.fn(),
})

describe('text_fields', () => {
    beforeEach(() => {
        document.body.innerHTML = ''
    })

    describe('handleTextFields()', () => {
        let subscriptions = new Subscription()

        afterEach(() => {
            RENDER.mockClear()
            subscriptions.unsubscribe()
            subscriptions = new Subscription()
        })

        const createTestElement = () => {
            const el = document.createElement('textarea')
            el.className = `test test-${uniqueId()}`
            document.body.appendChild(el)
            return el
        }

        test('detects text fields based on selectors', async () => {
            const { services } = await integrationTestContext(undefined, { roots: [], editors: [] })
            const textFieldElement = createTestElement()
            textFieldElement.id = 'text-field'
            textFieldElement.value = 'abc'
            textFieldElement.setSelectionRange(2, 3)
            subscriptions.add(
                handleTextFields(
                    of([{ addedNodes: [document.body], removedNodes: [] }]),
                    { extensionsController: createMockController(services) },
                    {
                        textFieldResolvers: [
                            { selector: 'textarea', resolveView: () => ({ element: textFieldElement }) },
                        ],
                    }
                )
            )
            const editors = await from(services.editor.editors)
                .pipe(
                    skip(2),
                    take(1)
                )
                .toPromise()
            expect(editors).toEqual([
                {
                    editorId: 'editor#0',
                    isActive: true,
                    resource: 'comment://0',
                    model: {
                        uri: 'comment://0',
                        text: 'abc',
                        languageId: 'plaintext',
                    },
                    selections: [
                        {
                            anchor: { line: 0, character: 2 },
                            active: { line: 0, character: 3 },
                            start: { line: 0, character: 2 },
                            end: { line: 0, character: 3 },
                            isReversed: false,
                        },
                    ],
                    type: 'CodeEditor',
                },
            ] as CodeEditor[])
            expect(textFieldElement.classList.contains('sg-mounted')).toBe(true)
        })
    })
})
