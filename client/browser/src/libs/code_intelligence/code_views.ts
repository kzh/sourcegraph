import { DOMFunctions, PositionAdjuster } from '@sourcegraph/codeintellify'
import { Observable, of, zip } from 'rxjs'
import { catchError, map, switchMap } from 'rxjs/operators'
import { FileSpec, RepoSpec, ResolvedRevSpec, RevSpec } from '../../../../../shared/src/util/url'
import { ERPRIVATEREPOPUBLICSOURCEGRAPHCOM, isErrorLike } from '../../shared/backend/errors'
import { ButtonProps } from '../../shared/components/CodeViewToolbar'
import { fetchBlobContentLines } from '../../shared/repo/backend'
import { CodeHost, FileInfo } from './code_intelligence'
import { ensureRevisionsAreCloned } from './util/file_info'
import { trackViews, ViewResolver } from './views'

/**
 * Describes a set of methods for interacting with a code view
 */
export interface CodeView extends Pick<ResolvedCodeView, Exclude<keyof ResolvedCodeView, 'element'>> {
    /** The DOMFunctions for the code view. */
    dom: DOMFunctions
    /**
     * Finds or creates a DOM element where we should inject the
     * `CodeViewToolbar`. This function is responsible for ensuring duplicate
     * mounts aren't created.
     */
    getToolbarMount?: (codeView: HTMLElement) => HTMLElement
    /**
     * Resolves the file info for a given code view. It returns an observable
     * because some code hosts need to resolve this asynchronously. The
     * observable should only emit once.
     */
    resolveFileInfo: (codeView: HTMLElement) => Observable<FileInfo>
    /**
     * In some situations, we need to be able to adjust the position going into
     * and coming out of codeintellify. For example, Phabricator converts tabs
     * to spaces in it's DOM.
     */
    adjustPosition?: PositionAdjuster<RepoSpec & RevSpec & FileSpec & ResolvedRevSpec>
    /** Props for styling the buttons in the `CodeViewToolbar`. */
    toolbarButtonProps?: ButtonProps
}

/**
 * TODO remove this completely in favour of ViewResolver<CodeViewResolver>
 *
 * Used to resolve elements matching a given selectors on the page
 * to a {@link ResolvedCodeView}.
 */
export interface CodeViewWithSelector extends CodeView {
    /** A selector used by `document.querySelectorAll` to find the code view. */
    selector: string
}

/**
 * A code view found on the page.
 */
export interface ResolvedCodeView extends CodeView {
    /**
     * The code view element on the page.
     */
    element: HTMLElement
}

/** Converts a static CodeViewSpec to a dynamic CodeViewSpecResolver. */
export const toCodeViewResolver = ({ selector, ...spec }: CodeViewWithSelector): ViewResolver<ResolvedCodeView> => ({
    selector,
    resolveView: element => ({ ...spec, element }),
})

/**
 * Find all the code views on a page using both the code view specs and the code view spec
 * resolvers, calling down to {@link trackViews}.
 */
export const trackCodeViews = ({ codeViewSpecResolvers }: Pick<CodeHost, 'codeViewSpecResolvers'>) =>
    trackViews<ResolvedCodeView>(codeViewSpecResolvers)

export interface FileInfoWithContents extends FileInfo {
    content?: string
    baseContent?: string
    headHasFileContents?: boolean
    baseHasFileContents?: boolean
}

export const fetchFileContents = (info: FileInfo): Observable<FileInfoWithContents> =>
    ensureRevisionsAreCloned(info).pipe(
        switchMap(info => {
            const fetchingBaseFile = info.baseCommitID
                ? fetchBlobContentLines({
                      repoName: info.repoName,
                      filePath: info.baseFilePath || info.filePath,
                      commitID: info.baseCommitID,
                  })
                : of(null)

            const fetchingHeadFile = fetchBlobContentLines({
                repoName: info.repoName,
                filePath: info.filePath,
                commitID: info.commitID,
            })
            return zip(fetchingBaseFile, fetchingHeadFile).pipe(
                map(
                    ([baseFileContent, headFileContent]): FileInfoWithContents => ({
                        ...info,
                        baseContent: baseFileContent ? baseFileContent.join('\n') : undefined,
                        content: headFileContent.join('\n'),
                        headHasFileContents: headFileContent.length > 0,
                        baseHasFileContents: baseFileContent ? baseFileContent.length > 0 : undefined,
                    })
                ),
                catchError(() => [info])
            )
        }),
        catchError((err: any) => {
            if (isErrorLike(err) && err.code === ERPRIVATEREPOPUBLICSOURCEGRAPHCOM) {
                return [info]
            }
            throw err
        })
    )
