import { Verification } from "@octokit/auth-oauth-device/dist-types/types"
import puppeteerExtra from "puppeteer-extra"
import { expect } from "chai"
import stealthMode from "puppeteer-extra-plugin-stealth"
import anonUserAgent from "puppeteer-extra-plugin-anonymize-ua"
import fetch from "node-fetch"
import { google } from "googleapis"
import { createOAuthDeviceAuth } from "@octokit/auth-oauth-device"
import { createUserWithEmailAndPassword, getAuth, GithubAuthProvider, UserCredential } from "firebase/auth"
import { FirebaseApp } from "firebase/app"
import { signInToFirebaseWithCredentials } from "../../src"
import { getAuthenticationConfiguration, sleep } from "./configs"

/**
 * Create a new Firebase user account with specified email and password.
 * @notice On successful creation of the user account, this user will also be signed in to your application.
 * @dev The pw MUST not be the one used for login with the email on Google or other email providers. The pw is only valid for authentication with Firebase.
 * @param userApp <FirebaseApp> - the initialized instance of the Firebase app.
 * @param email <string> - the personal user email.
 * @param pw <string> - a password to be associated with the user personal email here in Firebase.
 * @returns <Promise<UserCredential>>
 */
export const createNewFirebaseUserWithEmailAndPw = async (
    userApp: FirebaseApp,
    email: string,
    pw: string
): Promise<UserCredential> => createUserWithEmailAndPassword(getAuth(userApp), email, pw)

/**
 * Return the verification code needed to complete the access with Github.
 * @param gmailUserEmail <string> - the GMail email address.
 * @param gmailClientId <string> - the GMail client identifier.
 * @param gmailClientSecret <string> - the GMail client secret.
 * @param gmailRedirectUrl <string> - the GMail redirect url.
 * @param gmailRefreshToken <string> - the GMail refresh token.
 * @dev You should have the GMail APIs for OAuth2.0 must be enabled and configured properly in order to get correct results.
 * @returns <Promise<string>> - return the 6 digits verification code needed to complete the access with Github.
 */
export const getLastGithubVerificationCode = async (
    gmailUserEmail: string,
    gmailClientId: string,
    gmailClientSecret: string,
    gmailRedirectUrl: string,
    gmailRefreshToken: string
): Promise<string> => {
    // Configure Google OAuth2.0 client.
    const oAuth2Client = new google.auth.OAuth2(gmailClientId, gmailClientSecret, gmailRedirectUrl)
    oAuth2Client.setCredentials({ refresh_token: gmailRefreshToken })
    // Get access token.
    const { token } = await oAuth2Client.getAccessToken()

    // Fetch messages (emails) and retrieve the id of the last one.
    let response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${gmailUserEmail}/messages`, {
        headers: {
            Authorization: `Bearer ${token}`
        }
    })
    let body = await response.json()
    const lastMsgId = body.messages[0].id

    // Read last message using id.
    response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/${gmailUserEmail}/messages/${lastMsgId}`, {
        headers: {
            Authorization: `Bearer ${token}`
        }
    })
    body = await response.json()
    // Convert buffer.
    const message = Buffer.from(body.payload.body.data, "base64").toString()
    // Get OTP verification code.
    const otp = message.match(/[0-9]{6}/)?.toString()

    if (!otp) throw new Error("OTP code could not be retrieved.")

    return otp
}

/**
 * Simulate callback to manage the data requested for Github OAuth2.0 device flow.
 * @param verification <Verification> - the data from Github OAuth2.0 device flow.
 */
export const simulateOnVerification = async (verification: Verification): Promise<any> => {
    // 0.A Prepare data and plugins.
    const { userEmail, githubUserPw, gmailClientId, gmailClientSecret, gmailRedirectUrl, gmailRefreshToken } =
        getAuthenticationConfiguration()
    puppeteerExtra.use(stealthMode())
    puppeteerExtra.use(anonUserAgent({ stripHeadless: true }))

    // 0.B Browser and page.
    const args = ["--no-sandbox", "--disable-setuid-sandbox"]

    // Switch to 'headless: false' to debug using the Chrome browser.
    const browser = await puppeteerExtra.launch({ args, headless: false, channel: "chrome" })
    const ghPage = await browser.newPage()

    // 1. Navigate to Github login to execute device flow OAuth.
    ghPage.goto(verification.verification_uri)
    await Promise.race([
        ghPage.waitForNavigation({ waitUntil: "domcontentloaded" }),
        ghPage.waitForNavigation({ waitUntil: "load" })
    ])

    // Type data.
    await ghPage.waitForSelector(`.js-login-field`, { visible: true })
    await ghPage.waitForSelector(`.js-password-field`, { visible: true })

    await ghPage.type(".js-login-field", userEmail, { delay: 100 })
    await ghPage.type(".js-password-field", githubUserPw, { delay: 100 })

    // Confirm.
    await Promise.all([await ghPage.keyboard.press("Enter"), await ghPage.waitForNavigation()])

    await sleep(2000) // 2sec. to receive email.

    // 2. Get verification code from GMail using APIs.
    const verificationCode = await getLastGithubVerificationCode(
        userEmail,
        gmailClientId,
        gmailClientSecret,
        gmailRedirectUrl,
        gmailRefreshToken
    )

    // TODO: may happen that the session is maintained. So, we are ready to step 2. without need of step 1.3.
    // We need to get rid of sessions between e2e test workflows to avoid this scenario.

    // 1.3 Input verification code and complete sign-in.
    await ghPage.waitForSelector(`.js-verification-code-input-auto-submit`, { timeout: 10000, visible: true })
    await ghPage.type(".js-verification-code-input-auto-submit", verificationCode, { delay: 100 })
    // Confirm.
    await Promise.all([await ghPage.keyboard.press("Enter"), await ghPage.waitForNavigation()])

    // 2. Insert code for device activation.
    // Get input slots for digits besides the fourth ('-' char).
    const userCode0 = await ghPage.$("#user-code-0")
    const userCode1 = await ghPage.$("#user-code-1")
    const userCode2 = await ghPage.$("#user-code-2")
    const userCode3 = await ghPage.$("#user-code-3")
    const userCode5 = await ghPage.$("#user-code-5")
    const userCode6 = await ghPage.$("#user-code-6")
    const userCode7 = await ghPage.$("#user-code-7")
    const userCode8 = await ghPage.$("#user-code-8")
    // Type digits.
    await userCode0?.type(verification.user_code[0], { delay: 100 })
    await userCode1?.type(verification.user_code[1], { delay: 100 })
    await userCode2?.type(verification.user_code[2], { delay: 100 })
    await userCode3?.type(verification.user_code[3], { delay: 100 })
    await userCode5?.type(verification.user_code[5], { delay: 100 })
    await userCode6?.type(verification.user_code[6], { delay: 100 })
    await userCode7?.type(verification.user_code[7], { delay: 100 })
    await userCode8?.type(verification.user_code[8], { delay: 100 })
    // Progress.
    const continueButton = await ghPage.$('[name="commit"]')
    await Promise.all([await continueButton?.click(), ghPage.waitForNavigation()])

    // 3. Confirm authorization for association of account and application.
    await sleep(2000) // wait for authorize button be clickable.

    const authorizeButton = await ghPage.$('[id="js-oauth-authorize-btn"]')
    await Promise.all([await authorizeButton?.click(), ghPage.waitForNavigation()])

    // 4. Check for completion and close browser.
    // TODO: Add sign out from Github to avoid maintaining multiple active sessions.
    const completedTextElem = await ghPage.$("p[class='text-center']")
    await Promise.all([
        expect(await (await completedTextElem?.getProperty("textContent"))?.jsonValue()).to.be.equal(
            "Your device is now connected."
        ),
        await browser.close()
    ])
}

/**
 * Reproduce the Github Device Flow OAuth2.0 and Firebase credential handshake to authenticate a user.
 * @notice This works only in production environment.
 * @param userApp <FirebaseApp> - the Firebase user Application instance.
 * @param clientId <string> - the Github client id.
 * @returns <Promise<UserCredential>> - the credential of the user after the handshake with Firebase.
 */
export const authenticateUserWithGithub = async (userApp: FirebaseApp, clientId: string): Promise<UserCredential> => {
    const clientType = "oauth-app"
    const tokenType = "oauth"

    const auth = createOAuthDeviceAuth({
        clientType,
        clientId,
        scopes: ["gist"],
        onVerification: simulateOnVerification
    })

    // Get the access token.
    const { token } = await auth({
        type: tokenType
    })

    // Get and exchange credentials.
    const userFirebaseCredentials = GithubAuthProvider.credential(token)
    return signInToFirebaseWithCredentials(userApp, userFirebaseCredentials)
}