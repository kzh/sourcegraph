import { upperFirst } from 'lodash'
import AlertCircleIcon from 'mdi-react/AlertCircleIcon'
import MapSearchIcon from 'mdi-react/MapSearchIcon'
import * as React from 'react'
import { Route, RouteComponentProps, Switch } from 'react-router'
import { combineLatest, Observable, Subject, Subscription } from 'rxjs'
import { catchError, distinctUntilChanged, map, startWith, switchMap } from 'rxjs/operators'
import { extensionIDsFromSettings } from '../../../shared/src/extensions/extension'
import { queryConfiguredRegistryExtensions } from '../../../shared/src/extensions/helpers'
import { gql } from '../../../shared/src/graphql/graphql'
import * as GQL from '../../../shared/src/graphql/schema'
import { PlatformContextProps } from '../../../shared/src/platform/context'
import { gqlToCascade, SettingsCascadeProps } from '../../../shared/src/settings/settings'
import { asError, createAggregateError, ErrorLike, isErrorLike } from '../../../shared/src/util/errors'
import { queryGraphQL } from '../backend/graphql'
import { HeroPage } from '../components/HeroPage'
import { ThemeProps } from '../theme'
import { eventLogger } from '../tracking/eventLogger'
import { mergeSettingsSchemas } from './configuration'
import { SettingsPage } from './SettingsPage'

const NotFoundPage = () => <HeroPage icon={MapSearchIcon} title="404: Not Found" />

/** Props shared by SettingsArea and its sub-pages. */
interface SettingsAreaPageCommonProps extends PlatformContextProps, SettingsCascadeProps, ThemeProps {
    /** The subject whose settings to edit. */
    subject: Pick<GQL.SettingsSubject, '__typename' | 'id'>

    /**
     * The currently authenticated user, NOT (necessarily) the user who is the subject of the page.
     */
    authenticatedUser: GQL.IUser | null
}

interface SettingsData {
    subjects: GQL.ISettingsCascade['subjects']
    settingsJSONSchema: { $id: string }
}

/** Properties passed to all pages in the settings area. */
export interface SettingsAreaPageProps extends SettingsAreaPageCommonProps {
    /** The settings data, or null if the subject has no settings yet. */
    data: SettingsData

    /** Called when the page updates the subject's settings. */
    onUpdate: () => void
}

interface Props extends SettingsAreaPageCommonProps, RouteComponentProps<{}> {
    className?: string
    extraHeader?: JSX.Element
}

const LOADING: 'loading' = 'loading'

interface State {
    /**
     * The data, loading, or an error.
     */
    dataOrError: typeof LOADING | SettingsData | ErrorLike
}

/**
 * A settings area with a top-level JSON editor and sub-pages for editing nested settings values.
 */
export class SettingsArea extends React.Component<Props, State> {
    public state: State = { dataOrError: LOADING }

    private subjectChanges = new Subject<Pick<GQL.ISettingsSubject, 'id'>>()
    private refreshRequests = new Subject<void>()
    private subscriptions = new Subscription()

    public componentDidMount(): void {
        eventLogger.logViewEvent(`Settings${this.props.subject.__typename}`)
        // Load settings.
        this.subscriptions.add(
            combineLatest(this.subjectChanges, this.refreshRequests.pipe(startWith<void>(void 0)))
                .pipe(
                    distinctUntilChanged(),
                    switchMap(([{ id }]) =>
                        fetchSettingsCascade(id).pipe(
                            switchMap(cascade =>
                                this.getMergedSettingsJSONSchema(cascade).pipe(
                                    map(settingsJSONSchema => ({ subjects: cascade.subjects, settingsJSONSchema }))
                                )
                            ),
                            catchError(error => [asError(error)]),
                            map(c => ({ dataOrError: c }))
                        )
                    )
                )
                .subscribe(stateUpdate => this.setState(stateUpdate), err => console.error(err))
        )

        this.subjectChanges.next(this.props.subject)
    }

    public componentWillReceiveProps(props: Props): void {
        if (props.subject !== this.props.subject) {
            this.subjectChanges.next(props.subject)
        }
    }

    public componentWillUnmount(): void {
        this.subscriptions.unsubscribe()
    }

    public render(): JSX.Element | null {
        if (this.state.dataOrError === LOADING) {
            return null // loading
        }
        if (isErrorLike(this.state.dataOrError)) {
            return (
                <HeroPage icon={AlertCircleIcon} title="Error" subtitle={upperFirst(this.state.dataOrError.message)} />
            )
        }

        let term: string
        switch (this.props.subject.__typename) {
            case 'User':
                term = 'User'
                break
            case 'Org':
                term = 'Organization'
                break
            case 'Site':
                term = 'Global'
                break
            case 'DefaultSettings':
                term = 'Default settings'
                break
            default:
                term = 'Unknown'
                break
        }

        const transferProps: SettingsAreaPageProps = {
            data: this.state.dataOrError,
            subject: this.props.subject,
            authenticatedUser: this.props.authenticatedUser,
            onUpdate: this.onUpdate,
            isLightTheme: this.props.isLightTheme,
            platformContext: this.props.platformContext,
            settingsCascade: this.props.settingsCascade,
        }

        return (
            <div className={this.props.className || ''}>
                <h2>{term} settings</h2>
                {this.props.extraHeader}
                <Switch>
                    <Route
                        path={this.props.match.url}
                        key="hardcoded-key" // see https://github.com/ReactTraining/react-router/issues/4578#issuecomment-334489490
                        exact={true}
                        // tslint:disable-next-line:jsx-no-lambda
                        render={routeComponentProps => <SettingsPage {...routeComponentProps} {...transferProps} />}
                    />
                    <Route key="hardcoded-key" component={NotFoundPage} />
                </Switch>
            </div>
        )
    }

    private onUpdate = () => this.refreshRequests.next()

    private getMergedSettingsJSONSchema(cascade: Pick<GQL.ISettingsCascade, 'subjects'>): Observable<{ $id: string }> {
        return queryConfiguredRegistryExtensions(
            this.props.platformContext,
            extensionIDsFromSettings(gqlToCascade(cascade))
        ).pipe(
            catchError(error => {
                console.warn('Unable to get extension settings JSON Schemas for settings editor.', { error })
                return [null]
            }),
            map(configuredExtensions => ({
                $id: 'mergedSettings.schema.json#',
                ...(configuredExtensions ? mergeSettingsSchemas(configuredExtensions) : null),
            }))
        )
    }
}

function fetchSettingsCascade(subject: GQL.ID): Observable<Pick<GQL.ISettingsCascade, 'subjects'>> {
    return queryGraphQL(
        gql`
            query SettingsCascade($subject: ID!) {
                settingsSubject(id: $subject) {
                    settingsCascade {
                        subjects {
                            latestSettings {
                                id
                                contents
                            }
                        }
                    }
                }
            }
        `,
        { subject }
    ).pipe(
        map(({ data, errors }) => {
            if (!data || !data.settingsSubject) {
                throw createAggregateError(errors)
            }
            return data.settingsSubject.settingsCascade
        })
    )
}
