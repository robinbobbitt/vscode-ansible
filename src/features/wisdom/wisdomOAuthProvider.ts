/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable tsdoc/syntax */
import {
  authentication,
  AuthenticationProvider,
  AuthenticationProviderAuthenticationSessionsChangeEvent,
  AuthenticationSession,
  Disposable,
  env,
  EventEmitter,
  ExtensionContext,
  ProgressLocation,
  Uri,
  window,
  commands,
} from "vscode";
import { v4 as uuid } from "uuid";
import { PromiseAdapter, promiseFromEvent } from "./utils/promiseHandlers";
import axios from "axios";
import { TreeDataProvider } from "../../treeView";
import { SettingsManager } from "../../settings";
import {
  generateCodeVerifier,
  generateCodeChallengeFromVerifier,
  UriEventHandler,
  OAuthAccount,
  calculateTokenExpiryTime,
  WISDOM_AUTH_ID,
  WISDOM_AUTH_NAME,
  SESSIONS_SECRET_KEY,
  ACCOUNT_SECRET_KEY,
  LoggedInUserInfo,
} from "./utils/oAuth";
import {
  WisdomCommands,
  WISDOM_CLIENT_ID,
  WISDOM_SERVICE_LOGIN_TIMEOUT,
} from "../../definitions/constants";

const CODE_VERIFIER = generateCodeVerifier();
const CODE_CHALLENGE = generateCodeChallengeFromVerifier(CODE_VERIFIER);

// Grace time for sending request to refresh token
const GRACE_TIME = 10;

export class WisdomAuthenticationProvider
  implements AuthenticationProvider, Disposable
{
  public settingsManager: SettingsManager;
  private _sessionChangeEmitter =
    new EventEmitter<AuthenticationProviderAuthenticationSessionsChangeEvent>();
  private _disposable: Disposable;
  private _uriHandler = new UriEventHandler();

  constructor(
    private readonly context: ExtensionContext,
    settingsManager: SettingsManager
  ) {
    this.settingsManager = settingsManager;
    this._disposable = Disposable.from(
      authentication.registerAuthenticationProvider(
        WISDOM_AUTH_ID,
        WISDOM_AUTH_NAME,
        this,
        { supportsMultipleAccounts: false }
      ),
      window.registerUriHandler(this._uriHandler)
    );
  }

  get redirectUri() {
    const publisher = this.context.extension.packageJSON.publisher;
    const name = this.context.extension.packageJSON.name;

    return `${env.uriScheme}://${publisher}.${name}`;
  }

  get onDidChangeSessions() {
    return this._sessionChangeEmitter.event;
  }

  /**
   * Get the existing sessions
   * @param scopes
   * @returns
   */
  public async getSessions(): Promise<readonly AuthenticationSession[]> {
    const allSessions = await this.context.secrets.get(SESSIONS_SECRET_KEY);

    if (allSessions) {
      return JSON.parse(allSessions) as AuthenticationSession[];
    }

    return [];
  }

  /**
   * Create a new auth session
   * @param scopes
   * @returns
   */
  public async createSession(scopes: string[]): Promise<AuthenticationSession> {
    try {
      const account = await this.login(scopes);

      if (!account) {
        throw new Error(`Ansible wisdom login failure`);
      }

      const userinfo: LoggedInUserInfo = await this.getUserInfo(
        account.accessToken
      );

      const identifier = uuid();
      const session: AuthenticationSession = {
        id: identifier,
        accessToken: account.accessToken,
        account: {
          label: userinfo.username,
          id: identifier,
        },
        scopes: [],
        // scopes: account.scope,
      };

      await this.context.secrets.store(
        SESSIONS_SECRET_KEY,
        JSON.stringify([session])
      );

      this._sessionChangeEmitter.fire({
        added: [session],
        removed: [],
        changed: [],
      });

      console.log("[oauth] Session created...");

      return session;
    } catch (e) {
      window.showErrorMessage(`Ansible wisdom sign in failed: ${e}`);
      throw e;
    }
  }

  /**
   * Remove an existing session
   * @param sessionId
   */
  public async removeSession(sessionId: string): Promise<void> {
    const allSessions = await this.context.secrets.get(SESSIONS_SECRET_KEY);
    if (allSessions) {
      const sessions = JSON.parse(allSessions) as AuthenticationSession[];
      const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
      const session = sessions[sessionIdx];
      sessions.splice(sessionIdx, 1);

      await this.context.secrets.store(
        SESSIONS_SECRET_KEY,
        JSON.stringify(sessions)
      );

      if (session) {
        this._sessionChangeEmitter.fire({
          added: [],
          removed: [session],
          changed: [],
        });
        window.registerTreeDataProvider(
          "wisdom-explorer-treeview",
          new TreeDataProvider(undefined)
        );
      }
    }
  }

  /**
   * Dispose the registered services
   */
  public async dispose() {
    this._disposable.dispose();
  }

  /* Log in to wisdom auth service*/
  private async login(scopes: string[] = []) {
    console.log("[oauth] Logging in...");

    const searchParams = new URLSearchParams([
      ["response_type", "code"],
      ["code_challenge", CODE_CHALLENGE],
      ["code_challenge_method", "S256"],
      ["client_id", WISDOM_CLIENT_ID],
      ["redirect_uri", this.redirectUri],
    ]);

    const uri = Uri.parse(
      Uri.parse(this.settingsManager.settings.wisdomService.basePath)
        .with({
          path: "/o/authorize/",
          query: searchParams.toString(),
        })
        .toString(true)
    );
    console.log("[oauth] uri -> ", uri.toString());

    const {
      promise: receivedRedirectUrl,
      cancel: cancelWaitingForRedirectUrl,
    } = promiseFromEvent(this._uriHandler.event, this.handleUriForCode(scopes));

    await env.openExternal(uri);

    const account = await window.withProgress(
      {
        title:
          "Waiting for authentication redirect from Ansible wisdom service",
        location: ProgressLocation.Notification,
        cancellable: true,
      },
      async (_, token) =>
        Promise.race([
          receivedRedirectUrl,
          new Promise<OAuthAccount>((_, reject) => {
            setTimeout(
              () =>
                reject(
                  new Error(
                    "Cancelling the Wisdom OAuth login after 60s. Try again."
                  )
                ),
              WISDOM_SERVICE_LOGIN_TIMEOUT
            );
          }),
          promiseFromEvent<any, any>(
            token.onCancellationRequested,
            (_, __, reject) => {
              reject("User Cancelled");
            }
          ).promise,
        ]).finally(() => {
          cancelWaitingForRedirectUrl.fire();
        })
    );

    return account;
  }

  /* Handle the redirect to VS Code (after sign in from wisdom auth service) */
  private handleUriForCode: (
    scopes: readonly string[]
  ) => PromiseAdapter<Uri, OAuthAccount> =
    () => async (uri, resolve, reject) => {
      const query = new URLSearchParams(uri.query);
      const code = query.get("code");

      if (!code) {
        reject(new Error("No code receiver from the Wisdom OAuth Server"));
        return;
      }

      const account = await this.requestOAuthAccountFromCode(code);

      if (!account) {
        reject(new Error("Unable to form account"));
        return;
      }

      resolve(account);
    };

  /* Request access token from server using code */
  private async requestOAuthAccountFromCode(
    code: string
  ): Promise<OAuthAccount | undefined> {
    const headers = {
      "Cache-Control": "no-cache",
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const postData = {
      client_id: WISDOM_CLIENT_ID,
      code: code,
      code_verifier: CODE_VERIFIER,
      redirect_uri: this.redirectUri,
      grant_type: "authorization_code",
    };

    console.log("[oauth] Sending request for access token...");

    try {
      const { data } = await axios.post(
        `${this.settingsManager.settings.wisdomService.basePath}/o/token/`,
        postData,
        {
          headers: headers,
        }
      );

      const account: OAuthAccount = {
        type: "oauth",
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAtTimestampInSeconds: calculateTokenExpiryTime(data.expires_in),
        // scope: data.scope,
      };
      // store the account info
      this.context.secrets.store(ACCOUNT_SECRET_KEY, JSON.stringify(account));

      return account;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.log("error message: ", error.message);
        throw new Error("An unexpected error occurred");
      } else {
        console.log("unexpected error: ", error);
        throw new Error("An unexpected error occurred");
      }
    }
  }

  /* Request new access token using refresh token */
  private async requestTokenAfterExpiry(
    currentAccount: OAuthAccount
  ): Promise<OAuthAccount | undefined> {
    const headers = {
      "Cache-Control": "no-cache",
      "Content-Type": "application/x-www-form-urlencoded",
    };

    const postData = {
      client_id: WISDOM_CLIENT_ID,
      refresh_token: currentAccount.refreshToken,
      grant_type: "refresh_token",
    };

    console.log("[oauth] Sending request for a new access token...");

    const account = await window.withProgress(
      {
        title: "Refreshing token",
        location: ProgressLocation.Notification,
      },
      async () => {
        return axios
          .post(
            `${this.settingsManager.settings.wisdomService.basePath}/o/token/`,
            postData,
            {
              headers: headers,
            }
          )
          .then((response) => {
            const data = response.data;
            const account: OAuthAccount = {
              ...currentAccount,
              accessToken: data.access_token,
              refreshToken: data.refresh_token,
              expiresAtTimestampInSeconds: calculateTokenExpiryTime(
                data.expires_in
              ),
              // scope: data.scope,
            };

            // store the account info
            this.context.secrets.store(
              ACCOUNT_SECRET_KEY,
              JSON.stringify(account)
            );

            return account;
          })
          .catch((error) => {
            console.error(error);
            return;
          });
      }
    );

    return account ? (account as OAuthAccount) : undefined;
  }

  /**
   * Method that returns access token to be used in API calls
   * The method also checks if the token is expired or not, if so,
   * it requests for a new token and updates the secret store
   */
  public async grantAccessToken() {
    console.log("[oauth] Granting access token...");

    // check if user the user has the wisdom setting active
    const session = await authentication.getSession("auth-wisdom", [], {
      createIfNone: false,
    });

    if (!session) {
      console.log("[oauth] Session not found. Returning...");
      const selection = await window.showWarningMessage(
        "You must be logged in to use this feature.\n",
        "Login"
      );
      if (selection === "Login") {
        commands.executeCommand(WisdomCommands.WISDOM_AUTH_REQUEST);
      }
      return;
    }

    console.log("[oauth] Session found");

    const sessionId = session.id;

    const account = await this.context.secrets.get(ACCOUNT_SECRET_KEY);
    if (!account) {
      throw new Error(`Unable to fetch account`);
    }

    console.log("[oauth] Account found");

    const currentAccount: OAuthAccount = JSON.parse(account);
    let tokenToBeReturned = currentAccount.accessToken;

    // check if token needs to be refreshed
    const timeNow = Math.floor(new Date().getTime() / 1000);
    if (timeNow >= currentAccount["expiresAtTimestampInSeconds"] - GRACE_TIME) {
      // get new token
      console.log("[oauth] Ansible wisdom token expired. Getting new token...");

      const result = await this.requestTokenAfterExpiry(currentAccount);
      console.log(`[oauth] New Ansible wisdom  token received ${result}`);

      if (!result) {
        // handle error
        console.log("Failed to refresh token.");
        window.showErrorMessage(
          "Failed to refresh token. Please log out and log in again"
        );
        return;
      }

      window.showInformationMessage("Ansible wisdom token refreshed!");

      const newAccount: OAuthAccount = result;

      await this.context.secrets.store(
        ACCOUNT_SECRET_KEY,
        JSON.stringify(newAccount)
      );

      tokenToBeReturned = newAccount.accessToken;

      // change the session id of the existing session
      const allSessions = await this.context.secrets.get(SESSIONS_SECRET_KEY);
      if (allSessions) {
        const sessions = JSON.parse(allSessions) as AuthenticationSession[];
        const sessionIdx = sessions.findIndex((s) => s.id === sessionId);
        const session = sessions[sessionIdx];
        const freshSession: AuthenticationSession = {
          ...session,
          accessToken: tokenToBeReturned,
        };
        sessions.splice(sessionIdx, 1, freshSession);

        await this.context.secrets.store(
          SESSIONS_SECRET_KEY,
          JSON.stringify(sessions)
        );

        this._sessionChangeEmitter.fire({
          added: [],
          removed: [],
          changed: [session],
        });
      }
    }

    return tokenToBeReturned;
  }

  /* Get the user info from server */
  private async getUserInfo(token: string) {
    console.log("[oauth] Sending request for logged-in user info...");

    try {
      const { data } = await axios.get(
        `${this.settingsManager.settings.wisdomService.basePath}/api/me/`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      return data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.log("error message: ", error.message);
        throw new Error(error.message);
      } else {
        console.log("unexpected error: ", error);
        throw new Error("An unexpected error occurred");
      }
    }
  }
}
