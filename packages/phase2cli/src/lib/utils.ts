import { request } from "@octokit/request"
import { DocumentData, Firestore, Timestamp } from "firebase/firestore"
import ora, { Ora } from "ora"
import figlet from "figlet"
import clear from "clear"
import { zKey } from "snarkjs"
import winston, { Logger } from "winston"
import { Functions, HttpsCallable, httpsCallable, httpsCallableFromURL } from "firebase/functions"
import { Timer } from "timer-node"
import mime from "mime-types"
import { getDiskInfoSync } from "node-disk-info"
import Drive from "node-disk-info/dist/classes/drive"
import open from "open"
import dotenv from "dotenv"
import {
    FirebaseDocumentInfo,
    FirebaseServices,
    ParticipantContributionStep,
    ParticipantStatus,
    Timing,
    VerifyContributionComputation
} from "../../types/index"
import { collections, emojis, firstZkeyIndex, numIterationsExp, paths, symbols, theme } from "./constants"
import { initServices, uploadFileToStorage } from "./firebase"
import { GENERIC_ERRORS, GITHUB_ERRORS, showError } from "./errors"
import { readFile, writeFile } from "./files"
import {
    closeMultiPartUpload,
    downloadLocalFileFromBucket,
    getChunksAndPreSignedUrls,
    openMultiPartUpload,
    uploadParts
} from "./storage"
import { getAllCeremonies, getCurrentActiveParticipantTimeout } from "./queries"
import { getCurrentContributorContribution } from "packages/actions/src/helpers/query"
import { 
    getBucketName,
    getValidContributionAttestation
 } from '@zkmpc/actions'

dotenv.config()

/**
 * Get the Github username for the logged in user.
 * @param token <string> - the Github OAuth 2.0 token.
 * @returns <Promise<string>> - the user Github username.
 */
export const getGithubUsername = async (token: string): Promise<string> => {
    // Get user info from Github APIs.
    const response = await request("GET https://api.github.com/user", {
        headers: {
            authorization: `token ${token}`
        }
    })

    if (response) return response.data.login
    showError(GITHUB_ERRORS.GITHUB_GET_USERNAME_FAILED, true)

    return process.exit(0) // nb. workaround to avoid type issues.
}

/**
 * Get the current amout of available memory for user root disk (mounted in `/` root).
 * @returns <number> - the available memory in kB.
 */
export const getParticipantCurrentDiskAvailableSpace = (): number => {
    const disks = getDiskInfoSync()
    const root = disks.filter((disk: Drive) => disk.mounted === `/`)

    if (root.length !== 1) showError(`Something went wrong while retrieving your root disk available memory`, true)

    const rootDisk = root.at(0)!

    return rootDisk.available
}

/**
 * Return an array of true of false based on contribution verification result per each circuit.
 * @param ceremonyId <string> - the unique identifier of the ceremony.
 * @param participantId <string> - the unique identifier of the contributor.
 * @param circuits <Array<FirebaseDocumentInfo>> - the Firestore documents of the ceremony circuits.
 * @param finalize <boolean> - true when finalizing; otherwise false.
 * @returns <Promise<Array<boolean>>>
 */
export const getContributorContributionsVerificationResults = async (
    firestore: Firestore,
    ceremonyId: string,
    participantId: string,
    circuits: Array<FirebaseDocumentInfo>,
    finalize: boolean
): Promise<Array<boolean>> => {
    // Keep track contributions verification results.
    const contributions: Array<boolean> = []

    // Retrieve valid/invalid contributions.
    for await (const circuit of circuits) {
        // Get contributions to circuit from contributor.
        const contributionsToCircuit = await getCurrentContributorContribution(firestore, ceremonyId, circuit.id, participantId)

        let contribution: FirebaseDocumentInfo

        if (finalize)
            // There should be two contributions from coordinator (one is finalization).
            contribution = contributionsToCircuit
                .filter((contrib: FirebaseDocumentInfo) => contrib.data.zkeyIndex === "final")
                .at(0)!
        // There will be only one contribution.
        else contribution = contributionsToCircuit.at(0)!

        if (contribution) {
            // Get data.
            const contributionData = contribution.data

            if (!contributionData) showError(GENERIC_ERRORS.GENERIC_ERROR_RETRIEVING_DATA, true)

            // Update contributions validity.
            contributions.push(!!contributionData?.valid)
        }
    }

    return contributions
}


/**
 * Publish a new attestation through a Github Gist.
 * @param token <string> - the Github OAuth 2.0 token.
 * @param content <string> - the content of the attestation.
 * @param ceremonyPrefix <string> - the ceremony prefix.
 * @param ceremonyTitle <string> - the ceremony title.
 */
export const publishGist = async (
    token: string,
    content: string,
    ceremonyPrefix: string,
    ceremonyTitle: string
): Promise<string> => {
    const response = await request("POST /gists", {
        description: `Attestation for ${ceremonyTitle} MPC Phase 2 Trusted Setup ceremony`,
        public: true,
        files: {
            [`${ceremonyPrefix}_attestation.txt`]: {
                content
            }
        },
        headers: {
            authorization: `token ${token}`
        }
    })

    if (response && response.data.html_url) return response.data.html_url
    showError(GITHUB_ERRORS.GITHUB_GIST_PUBLICATION_FAILED, true)

    return process.exit(0) // nb. workaround to avoid type issues.
}

/**
 * Extract from milliseconds the seconds, minutes, hours and days.
 * @param millis <number>
 * @returns <Timing>
 */
export const getSecondsMinutesHoursFromMillis = (millis: number): Timing => {
    // Get seconds from millis.
    let delta = millis / 1000

    const days = Math.floor(delta / 86400)
    delta -= days * 86400

    const hours = Math.floor(delta / 3600) % 24
    delta -= hours * 3600

    const minutes = Math.floor(delta / 60) % 60
    delta -= minutes * 60

    const seconds = Math.floor(delta) % 60

    return {
        seconds: seconds >= 60 ? 59 : seconds,
        minutes: minutes >= 60 ? 59 : minutes,
        hours: hours >= 24 ? 23 : hours,
        days
    }
}

/**
 * Return a string with double digits if the amount is one digit only.
 * @param amount <number>
 * @returns <string>
 */
export const convertToDoubleDigits = (amount: number): string => (amount < 10 ? `0${amount}` : amount.toString())

/**
 * Sleeps the function execution for given millis.
 * @dev to be used in combination with loggers when writing data into files.
 * @param ms <number> - sleep amount in milliseconds
 * @returns <Promise<any>>
 */
export const sleep = (ms: number): Promise<any> => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Return a custom spinner.
 * @param text <string> - the text that should be displayed as spinner status.
 * @param spinnerLogo <any> - the logo.
 * @returns <Ora> - a new Ora custom spinner.
 */
export const customSpinner = (text: string, spinnerLogo: any): Ora =>
    ora({
        text,
        spinner: spinnerLogo
    })

/**
 * Return a simple graphical loader to simulate loading or describe an asynchronous task.
 * @param loadingText <string> - the text that should be displayed while the loader is spinning.
 * @param logo <any> - the logo of the loader.
 * @param durationInMillis <number> - the loader duration time in milliseconds.
 * @param afterLoadingText <string> - the text that should be displayed for the loader stop.
 * @returns <Promise<void>>.
 */
export const simpleLoader = async (
    loadingText: string,
    logo: any,
    durationInMillis: number,
    afterLoadingText?: string
): Promise<void> => {
    // Define the loader.
    const loader = customSpinner(loadingText, logo)

    loader.start()

    // nb. wait for `durationInMillis` time while loader is spinning.
    await sleep(durationInMillis)

    if (afterLoadingText) loader.succeed(afterLoadingText)
    else loader.stop()
}

/**
 * Return the ceremonies prefixes for every ceremony.
 * @returns Promise<Array<string>>
 */
export const getCreatedCeremoniesPrefixes = async (): Promise<Array<string>> => {
    // Get all ceremonies documents.
    const ceremonies = await getAllCeremonies()

    let ceremoniesPrefixes = []

    // Return prefixes (if any ceremony).
    if (ceremonies.length > 0)
        ceremoniesPrefixes = ceremonies.map((ceremony: FirebaseDocumentInfo) => ceremony.data.prefix)

    return ceremoniesPrefixes
}

/**
 * Upload a file by subdividing it in chunks to AWS S3 bucket.
 * @param startMultiPartUploadCF <HttpsCallable<unknown, unknown>> - the CF for initiating a multi part upload.
 * @param generatePreSignedUrlsPartsCF <HttpsCallable<unknown, unknown>> - the CF for generating the pre-signed urls for each chunk.
 * @param completeMultiPartUploadCF <HttpsCallable<unknown, unknown>> - the CF for completing a multi part upload.
 * @param bucketName <string> - the name of the AWS S3 bucket.
 * @param objectKey <string> - the path of the object inside the AWS S3 bucket.
 * @param localPath <string> - the local path of the file to be uploaded.
 * @param temporaryStoreCurrentContributionMultiPartUploadId <HttpsCallable<unknown, unknown>> - the CF for enable resumable upload from last chunk by temporarily store the ETags and PartNumbers of already uploaded chunks.
 * @param temporaryStoreCurrentContributionUploadedChunkData <HttpsCallable<unknown, unknown>> - the CF for enable resumable upload from last chunk by temporarily store the ETags and PartNumbers of already uploaded chunks.
 * @param ceremonyId <string> - the unique identifier of the ceremony.
 * @param tempContributionData <any> - the temporary information necessary to resume an already started multi-part upload.
 */
export const multiPartUpload = async (
    startMultiPartUploadCF: HttpsCallable<unknown, unknown>,
    generatePreSignedUrlsPartsCF: HttpsCallable<unknown, unknown>,
    completeMultiPartUploadCF: HttpsCallable<unknown, unknown>,
    bucketName: string,
    objectKey: string,
    localPath: string,
    temporaryStoreCurrentContributionMultiPartUploadId?: HttpsCallable<unknown, unknown>,
    temporaryStoreCurrentContributionUploadedChunkData?: HttpsCallable<unknown, unknown>,
    ceremonyId?: string,
    tempContributionData?: any
) => {
    // Configuration checks.
    if (!process.env.CONFIG_PRESIGNED_URL_EXPIRATION_IN_SECONDS)
        showError(GENERIC_ERRORS.GENERIC_NOT_CONFIGURED_PROPERLY, true)

    // Get content type.
    const contentType = mime.lookup(localPath)

    // The Multi-Part Upload unique identifier.
    let uploadIdZkey = ""
    // Already uploaded chunks temp info (nb. useful only when resuming).
    let alreadyUploadedChunks = []

    // Check if the contributor can resume an already started multi-part upload.
    if (!tempContributionData || (!!tempContributionData && !tempContributionData.uploadId)) {
        // Start from scratch.
        const spinner = customSpinner(`Starting upload process...`, `clock`)
        spinner.start()

        uploadIdZkey = await openMultiPartUpload(startMultiPartUploadCF, bucketName, objectKey, ceremonyId)

        if (temporaryStoreCurrentContributionMultiPartUploadId)
            // Store Multi-Part Upload ID after generation.
            await temporaryStoreCurrentContributionMultiPartUploadId({
                ceremonyId,
                uploadId: uploadIdZkey
            })

        spinner.stop()
    } else {
        // Read temp info from Firestore.
        uploadIdZkey = tempContributionData.uploadId
        alreadyUploadedChunks = tempContributionData.chunks
    }

    // Step 2
    const spinner = customSpinner(`Splitting file in chunks...`, `clock`)
    spinner.start()

    const chunksWithUrlsZkey = await getChunksAndPreSignedUrls(
        generatePreSignedUrlsPartsCF,
        bucketName,
        objectKey,
        localPath,
        uploadIdZkey,
        Number(process.env.CONFIG_PRESIGNED_URL_EXPIRATION_IN_SECONDS!),
        ceremonyId
    )

    // Step 3
    const partNumbersAndETagsZkey = await uploadParts(
        chunksWithUrlsZkey,
        contentType,
        temporaryStoreCurrentContributionUploadedChunkData,
        ceremonyId,
        alreadyUploadedChunks
    )

    // Step 4
    spinner.text = `Completing upload...`
    spinner.start()

    await closeMultiPartUpload(
        completeMultiPartUploadCF,
        bucketName,
        objectKey,
        uploadIdZkey,
        partNumbersAndETagsZkey,
        ceremonyId
    )

    spinner.stop()
}

/**
 * Get a value from a key information about a circuit.
 * @param circuitInfo <string> - the stringified content of the .r1cs file.
 * @param rgx <RegExp> - regular expression to match the key.
 * @returns <string>
 */
export const getCircuitMetadataFromR1csFile = (circuitInfo: string, rgx: RegExp): string => {
    // Match.
    const matchInfo = circuitInfo.match(rgx)

    if (!matchInfo) showError(GENERIC_ERRORS.GENERIC_R1CS_MISSING_INFO, true)

    // Split and return the value.
    return matchInfo?.at(0)?.split(":")[1].replace(" ", "").split("#")[0].replace("\n", "")!
}

/**
 * Return the necessary Power of Tau "powers" given the number of circuits constraints.
 * @param constraints <number> - the number of circuit contraints.
 * @param outputs <number> - the number of circuit outputs.
 * @returns <number>
 */
export const estimatePoT = (constraints: number, outputs: number): number => {
    let power = 2
    let pot = 2 ** power

    while (constraints + outputs > pot) {
        power += 1
        pot = 2 ** power
    }

    return power
}

/**
 * Get the powers from pot file name
 * @dev the pot files must follow these convention (i_am_a_pot_file_09.ptau) where the numbers before '.ptau' are the powers.
 * @param potFileName <string>
 * @returns <number>
 */
export const extractPoTFromFilename = (potFileName: string): number =>
    Number(potFileName.split("_").pop()?.split(".").at(0))

/**
 * Extract a prefix (like_this) from a provided string with special characters and spaces.
 * @dev replaces all symbols and whitespaces with underscore.
 * @param str <string>
 * @returns <string>
 */
export const extractPrefix = (str: string): string =>
    // eslint-disable-next-line no-useless-escape
    str.replace(/[`\s~!@#$%^&*()|+\-=?;:'",.<>\{\}\[\]\\\/]/gi, "-").toLowerCase()

/**
 * Format the next zkey index.
 * @param progress <number> - the progression in zkey index (= contributions).
 * @returns <string>
 */
export const formatZkeyIndex = (progress: number): string => {
    let index = progress.toString()

    while (index.length < firstZkeyIndex.length) {
        index = `0${index}`
    }

    return index
}

/**
 * Convert milliseconds to seconds.
 * @param millis <number>
 * @returns <number>
 */
export const convertMillisToSeconds = (millis: number): number => Number((millis / 1000).toFixed(2))

/**
 * Bootstrap whatever is needed for a new command execution (clean terminal, print header, init Firebase services).
 * @returns <Promise<FirebaseServices>>
 */
export const bootstrapCommandExec = async (): Promise<FirebaseServices> => {
    // Clean terminal window.
    clear()

    // Print header.
    console.log(theme.magenta(figlet.textSync("Phase 2 cli", { font: "Ogre" })))

    // Initialize Firebase services
    return initServices()
}

/**
 * Gracefully terminate the command execution
 * @params ghUsername <string> - the Github username of the user.
 */
export const terminate = async (ghUsername: string) => {
    console.log(`\nSee you, ${theme.bold(`@${ghUsername}`)} ${emojis.wave}`)

    process.exit(0)
}

/**
 * Make a new countdown and throws an error when time is up.
 * @param durationInSeconds <number> - the amount of time to be counted in seconds.
 * @param intervalInSeconds <number> - update interval in seconds.
 */
export const createExpirationCountdown = (durationInSeconds: number, intervalInSeconds: number) => {
    let seconds = durationInSeconds <= 60 ? durationInSeconds : 60

    setInterval(() => {
        try {
            if (durationInSeconds !== 0) {
                // Update times.
                durationInSeconds -= intervalInSeconds
                seconds -= intervalInSeconds

                if (seconds % 60 === 0) seconds = 0

                process.stdout.write(
                    `${symbols.warning} Expires in ${theme.bold(
                        theme.magenta(`00:${Math.floor(durationInSeconds / 60)}:${seconds}`)
                    )}\r`
                )
            } else showError(GENERIC_ERRORS.GENERIC_COUNTDOWN_EXPIRED, true)
        } catch (err: any) {
            // Workaround to the \r.
            process.stdout.write(`\n\n`)
            showError(GENERIC_ERRORS.GENERIC_COUNTDOWN_EXPIRATION, true)
        }
    }, intervalInSeconds * 1000)
}

/**
 * Create and return a simple countdown for a specified amount of time.
 * @param remainingTime <number> - the amount of time to be counted.
 * @param message <string> - the message to be shown.
 * @returns <NodeJS.Timer>
 */
export const simpleCountdown = (remainingTime: number, message: string): NodeJS.Timer =>
    setInterval(() => {
        remainingTime -= 1000

        const {
            seconds: cdSeconds,
            minutes: cdMinutes,
            hours: cdHours
        } = getSecondsMinutesHoursFromMillis(Math.abs(remainingTime))

        process.stdout.write(
            `${message} (${remainingTime < 0 ? theme.bold(`-`) : ``}${convertToDoubleDigits(
                cdHours
            )}:${convertToDoubleDigits(cdMinutes)}:${convertToDoubleDigits(cdSeconds)})\r`
        )
    }, 1000)

/**
 * Manage the communication of timeout-related messages for a contributor.
 * @param participantData <DocumentData> - the data of the participant document.
 * @param participantId <string> - the unique identifier of the contributor.
 * @param ceremonyId <string> - the unique identifier of the ceremony.
 * @param isContributing <boolean>
 * @param ghUsername <string>
 */
export const handleTimedoutMessageForContributor = async (
    participantData: DocumentData,
    participantId: string,
    ceremonyId: string,
    isContributing: boolean,
    ghUsername: string
): Promise<void> => {
    // Extract data.
    const { status, contributionStep, contributionProgress } = participantData

    // Check if the contributor has been timedout.
    if (status === ParticipantStatus.TIMEDOUT && contributionStep !== ParticipantContributionStep.COMPLETED) {
        if (!isContributing) console.log(theme.bold(`\n- Circuit # ${theme.magenta(contributionProgress)}`))
        else process.stdout.write(`\n`)

        console.log(
            `${symbols.error} ${
                isContributing ? `You have been timedout while contributing` : `Timeout still in progress.`
            }\n\n${
                symbols.warning
            } This can happen due to network or memory issues, un/intentional crash, or contributions lasting for too long.`
        )

        // nb. workaround to retrieve the latest timeout data from the database.
        await simpleLoader(`Checking timeout...`, `clock`, 1000)

        // Check when the participant will be able to retry the contribution.
        const activeTimeouts = await getCurrentActiveParticipantTimeout(ceremonyId, participantId)

        if (activeTimeouts.length !== 1) showError(GENERIC_ERRORS.GENERIC_ERROR_RETRIEVING_DATA, true)

        const activeTimeoutData = activeTimeouts.at(0)?.data

        if (!activeTimeoutData) showError(GENERIC_ERRORS.GENERIC_ERROR_RETRIEVING_DATA, true)

        const { seconds, minutes, hours, days } = getSecondsMinutesHoursFromMillis(
            Number(activeTimeoutData?.endDate) - Timestamp.now().toMillis()
        )

        console.log(
            `${symbols.info} You can retry your contribution in ${theme.bold(
                `${convertToDoubleDigits(days)}:${convertToDoubleDigits(hours)}:${convertToDoubleDigits(
                    minutes
                )}:${convertToDoubleDigits(seconds)}`
            )} (dd/hh/mm/ss)`
        )

        terminate(ghUsername)
    }
}

/**
 * Compute a new Groth 16 Phase 2 contribution.
 * @param lastZkey <string> - the local path to last zkey.
 * @param newZkey <string> - the local path to new zkey.
 * @param name <string> - the name of the contributor.
 * @param entropyOrBeacon <string> - the value representing the entropy or beacon.
 * @param logger <Logger | Console> - custom winston or console logger.
 * @param finalize <boolean> - true when finalizing the ceremony with the last contribution; otherwise false.
 * @param contributionComputationTime <number> - the contribution computation time in milliseconds for the circuit.
 */
export const computeContribution = async (
    lastZkey: string,
    newZkey: string,
    name: string,
    entropyOrBeacon: string,
    logger: Logger | Console,
    finalize: boolean,
    contributionComputationTime: number
) => {
    // Format average contribution time.
    const { seconds, minutes, hours } = getSecondsMinutesHoursFromMillis(contributionComputationTime)

    // Custom spinner for visual feedback.
    const text = `${finalize ? `Applying beacon...` : `Computing contribution...`} ${
        contributionComputationTime > 0
            ? `(ETA ${theme.bold(
                  `${convertToDoubleDigits(hours)}:${convertToDoubleDigits(minutes)}:${convertToDoubleDigits(seconds)}`
              )} |`
            : ``
    }`

    let counter = 0

    // Format time.
    const {
        seconds: counterSeconds,
        minutes: counterMinutes,
        hours: counterHours
    } = getSecondsMinutesHoursFromMillis(counter)

    const spinner = customSpinner(
        `${text} ${convertToDoubleDigits(counterHours)}:${convertToDoubleDigits(
            counterMinutes
        )}:${convertToDoubleDigits(counterSeconds)})\r`,
        `clock`
    )
    spinner.start()

    const interval = setInterval(() => {
        counter += 1000

        const {
            seconds: counterSec,
            minutes: counterMin,
            hours: counterHrs
        } = getSecondsMinutesHoursFromMillis(counter)

        spinner.text = `${text} ${convertToDoubleDigits(counterHrs)}:${convertToDoubleDigits(
            counterMin
        )}:${convertToDoubleDigits(counterSec)})\r`
    }, 1000)

    if (finalize)
        // Finalize applying a random beacon.
        await zKey.beacon(lastZkey, newZkey, name, entropyOrBeacon, numIterationsExp, logger)
    // Compute the next contribution.
    else await zKey.contribute(lastZkey, newZkey, name, entropyOrBeacon, logger)

    // nb. workaround to logger descriptor close.
    await sleep(1000)

    spinner.stop()
    clearInterval(interval)
}

/**
 * Create a custom logger.
 * @dev useful for keeping track of `info` logs from snarkjs and use them to generate the contribution transcript.
 * @param transcriptFilename <string> - logger output file.
 * @returns <Logger>
 */
export const getTranscriptLogger = (transcriptFilename: string): Logger =>
    // Create a custom logger.
    winston.createLogger({
        level: "info",
        format: winston.format.printf((log) => log.message),
        transports: [
            // Write all logs with importance level of `info` to `transcript.json`.
            new winston.transports.File({
                filename: transcriptFilename,
                level: "info"
            })
        ]
    })

/**
 * Make a progress to the next contribution step for the current contributor.
 * @param firebaseFunctions <Functions> - the object containing the firebase functions.
 * @param ceremonyId <string> - the ceremony unique identifier.
 * @param showSpinner <boolean> - true to show a custom spinner on the terminal; otherwise false.
 * @param message <string> - custom message string based on next contribution step value.
 */
export const makeContributionStepProgress = async (
    firebaseFunctions: Functions,
    ceremonyId: string,
    showSpinner: boolean,
    message: string
) => {
    // Get CF.
    const progressToNextContributionStep = httpsCallable(firebaseFunctions, "progressToNextContributionStep")

    // Custom spinner for visual feedback.
    const spinner: Ora = customSpinner(`Getting ready for ${message} step`, "clock")

    if (showSpinner) spinner.start()

    // Progress to next contribution step.
    await progressToNextContributionStep({ ceremonyId })

    if (showSpinner) spinner.stop()
}

/**
 * Return the next circuit where the participant needs to compute or has computed the contribution.
 * @param circuits <Array<FirebaseDocumentInfo>> - the ceremony circuits document.
 * @param nextCircuitPosition <number> - the position in the sequence of circuits where the next contribution must be done.
 * @returns <FirebaseDocumentInfo>
 */
export const getNextCircuitForContribution = (
    circuits: Array<FirebaseDocumentInfo>,
    nextCircuitPosition: number
): FirebaseDocumentInfo => {
    // Filter for sequence position (should match contribution progress).
    const filteredCircuits = circuits.filter(
        (circuit: FirebaseDocumentInfo) => circuit.data.sequencePosition === nextCircuitPosition
    )

    // There must be only one.
    if (filteredCircuits.length !== 1) showError(GENERIC_ERRORS.GENERIC_ERROR_RETRIEVING_DATA, true)

    return filteredCircuits.at(0)!
}

/**
 * Generate the public attestation for the contributor.
 * @param ceremonyDoc <FirebaseDocumentInfo> - the ceremony document.
 * @param participantId <string> - the unique identifier of the participant.
 * @param participantData <DocumentData> - the data of the participant document.
 * @param circuits <Array<FirebaseDocumentInfo> - the ceremony circuits documents.
 * @param ghUsername <string> - the Github username of the contributor.
 * @param ghToken <string> - the Github access token of the contributor.
 */
export const generatePublicAttestation = async (
    firestore: Firestore,
    ceremonyDoc: FirebaseDocumentInfo,
    participantId: string,
    participantData: DocumentData,
    circuits: Array<FirebaseDocumentInfo>,
    ghUsername: string,
    ghToken: string
): Promise<void> => {
    // Attestation preamble.
    const attestationPreamble = `Hey, I'm ${ghUsername} and I have contributed to the ${ceremonyDoc.data.title} MPC Phase2 Trusted Setup ceremony.\nThe following are my contribution signatures:`

    // Return true and false based on contribution verification.
    const contributionsValidity = await getContributorContributionsVerificationResults(
        firestore,
        ceremonyDoc.id,
        participantId,
        circuits,
        false
    )
    const numberOfValidContributions = contributionsValidity.filter(Boolean).length

    console.log(
        `\nCongrats, you have successfully contributed to ${theme.magenta(
            theme.bold(numberOfValidContributions)
        )} out of ${theme.magenta(theme.bold(circuits.length))} circuits ${emojis.tada}`
    )

    // Show valid/invalid contributions per each circuit.
    let idx = 0

    for (const contributionValidity of contributionsValidity) {
        console.log(
            `${contributionValidity ? symbols.success : symbols.error} ${theme.bold(`Circuit`)} ${theme.bold(
                theme.magenta(idx + 1)
            )}`
        )
        idx += 1
    }

    process.stdout.write(`\n`)

    const spinner = customSpinner("Uploading public attestation...", "clock")
    spinner.start()

    // Get only valid contribution hashes.
    const attestation = await getValidContributionAttestation(
        firestore,
        contributionsValidity,
        circuits,
        participantData!,
        ceremonyDoc.id,
        participantId,
        attestationPreamble,
        false
    )

    writeFile(`${paths.attestationPath}/${ceremonyDoc.data.prefix}_attestation.log`, Buffer.from(attestation))
    await sleep(1000)

    // TODO: If fails for permissions problems, ask to do manually.
    const gistUrl = await publishGist(ghToken, attestation, ceremonyDoc.data.prefix, ceremonyDoc.data.title)

    spinner.succeed(
        `Public attestation successfully published as Github Gist at this link ${theme.bold(theme.underlined(gistUrl))}`
    )

    // Attestation link via Twitter.
    const attestationTweet = `https://twitter.com/intent/tweet?text=I%20contributed%20to%20the%20${ceremonyDoc.data.title}%20Phase%202%20Trusted%20Setup%20ceremony!%20You%20can%20contribute%20here:%20https://github.com/quadratic-funding/mpc-phase2-suite%20You%20can%20view%20my%20attestation%20here:%20${gistUrl}%20#Ethereum%20#ZKP`

    console.log(
        `\nWe appreciate your contribution to preserving the ${ceremonyDoc.data.title} security! ${
            emojis.key
        }  You can tweet about your participation if you'd like (click on the link below ${
            emojis.pointDown
        }) \n\n${theme.underlined(attestationTweet)}`
    )

    await open(attestationTweet)
}

/**
 * Download a local copy of the zkey.
 * @param cf <HttpsCallable<unknown, unknown>> - the corresponding cloud function.
 * @param bucketName <string> - the name of the AWS S3 bucket.
 * @param objectKey <string> - the identifier of the object (storage path).
 * @param localPath <string> - the path where the file will be written.
 * @param showSpinner <boolean> - true to show a custom spinner on the terminal; otherwise false.
 */
export const downloadContribution = async (
    functions: Functions,
    bucketName: string,
    objectKey: string,
    localPath: string,
    showSpinner: boolean
) => {
    // Custom spinner for visual feedback.
    const spinner: Ora = customSpinner(`Downloading contribution...`, "clock")

    if (showSpinner) spinner.start()

    // Download from storage.
    await downloadLocalFileFromBucket(functions, bucketName, objectKey, localPath)

    if (showSpinner) spinner.stop()
}

/**
 * Upload the new zkey to the storage.
 * @param storagePath <string> - the Storage path where the zkey will be stored.
 * @param localPath <string> - the local path where the zkey is stored.
 * @param showSpinner <boolean> - true to show a custom spinner on the terminal; otherwise false.
 */
export const uploadContribution = async (storagePath: string, localPath: string, showSpinner: boolean) => {
    // Custom spinner for visual feedback.
    const spinner = customSpinner("Storing your contribution...", "clock")
    if (showSpinner) spinner.start()

    // Upload to storage.
    await uploadFileToStorage(localPath, storagePath)

    if (showSpinner) spinner.stop()
}

/**
 * Compute a new Groth16 contribution verification.
 * @param ceremony <FirebaseDocumentInfo> - the ceremony document.
 * @param circuit <FirebaseDocumentInfo> - the circuit document.
 * @param ghUsername <string> - the Github username of the user.
 * @param avgVerifyCloudFunctionTime <number> - the average verify Cloud Function execution time in milliseconds.
 * @param firebaseFunctions <Functions> - the object containing the firebase functions.
 * @returns <Promise<VerifyContributionComputation>>
 */
export const computeVerification = async (
    ceremony: FirebaseDocumentInfo,
    circuit: FirebaseDocumentInfo,
    ghUsername: string,
    avgVerifyCloudFunctionTime: number,
    firebaseFunctions: Functions
): Promise<VerifyContributionComputation> => {
    // Format average verification time.
    const { seconds, minutes, hours } = getSecondsMinutesHoursFromMillis(avgVerifyCloudFunctionTime)

    // Custom spinner for visual feedback.
    const spinner = customSpinner(
        `Verifying your contribution... ${
            avgVerifyCloudFunctionTime > 0
                ? `(est. time ${theme.bold(
                      `${convertToDoubleDigits(hours)}:${convertToDoubleDigits(minutes)}:${convertToDoubleDigits(
                          seconds
                      )}`
                  )})`
                : ``
        }\n`,
        "clock"
    )

    spinner.start()

    // Verify contribution callable Cloud Function.
    const verifyContribution = httpsCallableFromURL(
        firebaseFunctions!,
        process.env.FIREBASE_CF_URL_VERIFY_CONTRIBUTION!,
        {
            timeout: 3600000
        }
    )

    // The verification must be done remotely (Cloud Functions).
    const response = await verifyContribution({
        ceremonyId: ceremony.id,
        circuitId: circuit.id,
        ghUsername,
        bucketName: getBucketName(ceremony.data.prefix)
    })

    spinner.stop()

    if (!response) showError(GENERIC_ERRORS.GENERIC_ERROR_RETRIEVING_DATA, true)

    const { data }: any = response

    return {
        valid: data.valid,
        verificationComputationTime: data.verificationComputationTime,
        verifyCloudFunctionTime: data.verifyCloudFunctionTime,
        fullContributionTime: data.fullContributionTime
    }
}

/**
 * Compute a new contribution for the participant.
 * @param ceremony <FirebaseDocumentInfo> - the ceremony document.
 * @param circuit <FirebaseDocumentInfo> - the circuit document.
 * @param entropyOrBeacon <any> - the entropy/beacon for the contribution.
 * @param ghUsername <string> - the Github username of the user.
 * @param finalize <boolean> - true if the contribution finalize the ceremony; otherwise false.
 * @param firebaseFunctions <Functions> - the object containing the firebase functions.
 * @param newParticipantData <DocumentData> - the object containing the participant data.
 * @returns <Promise<string>> - new updated attestation file.
 */
export const makeContribution = async (
    ceremony: FirebaseDocumentInfo,
    circuit: FirebaseDocumentInfo,
    entropyOrBeacon: any,
    ghUsername: string,
    finalize: boolean,
    firebaseFunctions: Functions,
    newParticipantData?: DocumentData
): Promise<void> => {
    // Extract data from circuit.
    const currentProgress = circuit.data.waitingQueue.completedContributions
    const { avgTimings } = circuit.data

    // Compute zkey indexes.
    const currentZkeyIndex = formatZkeyIndex(currentProgress)
    const nextZkeyIndex = formatZkeyIndex(currentProgress + 1)

    // Paths config.
    const transcriptsPath = finalize ? paths.finalTranscriptsPath : paths.contributionTranscriptsPath
    const contributionsPath = finalize ? paths.finalZkeysPath : paths.contributionsPath

    // Get custom transcript logger.
    const contributionTranscriptLocalPath = `${transcriptsPath}/${circuit.data.prefix}_${
        finalize ? `${ghUsername}_final` : nextZkeyIndex
    }.log`
    const transcriptLogger = getTranscriptLogger(contributionTranscriptLocalPath)
    const bucketName = getBucketName(ceremony.data.prefix)

    // Write first message.
    transcriptLogger.info(
        `${finalize ? `Final` : `Contribution`} transcript for ${circuit.data.prefix} phase 2 contribution.\n${
            finalize ? `Coordinator: ${ghUsername}` : `Contributor # ${Number(nextZkeyIndex)}`
        } (${ghUsername})\n`
    )

    console.log(
        `${theme.bold(`\n- Circuit # ${theme.magenta(`${circuit.data.sequencePosition}`)}`)} (Contribution Steps)`
    )

    if (
        finalize ||
        (!!newParticipantData?.contributionStep &&
            newParticipantData?.contributionStep === ParticipantContributionStep.DOWNLOADING)
    ) {
        const spinner = customSpinner(`Preparing for download...`, `clock`)
        spinner.start()

        // 1. Download last contribution.
        const storagePath = `${collections.circuits}/${circuit.data.prefix}/${collections.contributions}/${circuit.data.prefix}_${currentZkeyIndex}.zkey`
        const localPath = `${contributionsPath}/${circuit.data.prefix}_${currentZkeyIndex}.zkey`

        // Download w/ Presigned urls.
        const generateGetObjectPreSignedUrl = httpsCallable(firebaseFunctions!, "generateGetObjectPreSignedUrl")

        spinner.stop()

        await downloadContribution(firebaseFunctions, bucketName, storagePath, localPath, false)

        console.log(`${symbols.success} Contribution ${theme.bold(`#${currentZkeyIndex}`)} correctly downloaded`)

        // Make the step if not finalizing.
        if (!finalize) await makeContributionStepProgress(firebaseFunctions!, ceremony.id, true, "computation")
    } else console.log(`${symbols.success} Contribution ${theme.bold(`#${currentZkeyIndex}`)} already downloaded`)

    if (
        finalize ||
        (!!newParticipantData?.contributionStep &&
            newParticipantData?.contributionStep === ParticipantContributionStep.DOWNLOADING) ||
        newParticipantData?.contributionStep === ParticipantContributionStep.COMPUTING
    ) {
        const contributionComputationTimer = new Timer({ label: "contributionComputation" }) // Compute time (only for statistics).

        // 2.A Compute the new contribution.
        contributionComputationTimer.start()

        await computeContribution(
            `${contributionsPath}/${circuit.data.prefix}_${currentZkeyIndex}.zkey`,
            `${contributionsPath}/${circuit.data.prefix}_${finalize ? `final` : nextZkeyIndex}.zkey`,
            ghUsername,
            entropyOrBeacon,
            transcriptLogger,
            finalize,
            avgTimings.contributionComputation
        )

        contributionComputationTimer.stop()

        const contributionComputationTime = contributionComputationTimer.ms()

        const spinner = customSpinner(`Storing contribution time and hash...`, `clock`)
        spinner.start()

        // nb. workaround for file descriptor close.
        await sleep(2000)

        // 2.B Generate attestation from single contribution transcripts from each circuit (queue this contribution).
        const transcript = readFile(contributionTranscriptLocalPath)

        const matchContributionHash = transcript.match(/Contribution.+Hash.+\n\t\t.+\n\t\t.+\n.+\n\t\t.+\n/)

        if (!matchContributionHash) showError(GENERIC_ERRORS.GENERIC_CONTRIBUTION_HASH_INVALID, true)

        const contributionHash = matchContributionHash?.at(0)?.replace("\n\t\t", "")!

        const permanentlyStoreCurrentContributionTimeAndHash = httpsCallable(
            firebaseFunctions!,
            "permanentlyStoreCurrentContributionTimeAndHash"
        )

        await permanentlyStoreCurrentContributionTimeAndHash({
            ceremonyId: ceremony.id,
            contributionComputationTime,
            contributionHash
        })

        const {
            seconds: computationSeconds,
            minutes: computationMinutes,
            hours: computationHours
        } = getSecondsMinutesHoursFromMillis(contributionComputationTime)

        spinner.succeed(
            `${
                finalize ? "Contribution" : `Contribution ${theme.bold(`#${nextZkeyIndex}`)}`
            } computation took ${theme.bold(
                `${convertToDoubleDigits(computationHours)}:${convertToDoubleDigits(
                    computationMinutes
                )}:${convertToDoubleDigits(computationSeconds)}`
            )}`
        )

        // Make the step if not finalizing.
        if (!finalize) await makeContributionStepProgress(firebaseFunctions!, ceremony.id, true, "upload")
    } else console.log(`${symbols.success} Contribution ${theme.bold(`#${nextZkeyIndex}`)} already computed`)

    if (
        finalize ||
        (!!newParticipantData?.contributionStep &&
            newParticipantData?.contributionStep === ParticipantContributionStep.DOWNLOADING) ||
        newParticipantData?.contributionStep === ParticipantContributionStep.COMPUTING ||
        newParticipantData?.contributionStep === ParticipantContributionStep.UPLOADING
    ) {
        // 3. Store file.
        const storagePath = `${collections.circuits}/${circuit.data.prefix}/${collections.contributions}/${
            circuit.data.prefix
        }_${finalize ? `final` : nextZkeyIndex}.zkey`
        const localPath = `${contributionsPath}/${circuit.data.prefix}_${finalize ? `final` : nextZkeyIndex}.zkey`

        // Upload.
        const startMultiPartUpload = httpsCallable(firebaseFunctions, "startMultiPartUpload")
        const generatePreSignedUrlsParts = httpsCallable(firebaseFunctions, "generatePreSignedUrlsParts")
        const completeMultiPartUpload = httpsCallable(firebaseFunctions, "completeMultiPartUpload")

        if (!finalize) {
            const temporaryStoreCurrentContributionMultiPartUploadId = httpsCallable(
                firebaseFunctions,
                "temporaryStoreCurrentContributionMultiPartUploadId"
            )
            const temporaryStoreCurrentContributionUploadedChunk = httpsCallable(
                firebaseFunctions,
                "temporaryStoreCurrentContributionUploadedChunkData"
            )

            await multiPartUpload(
                startMultiPartUpload,
                generatePreSignedUrlsParts,
                completeMultiPartUpload,
                bucketName,
                storagePath,
                localPath,
                temporaryStoreCurrentContributionMultiPartUploadId,
                temporaryStoreCurrentContributionUploadedChunk,
                ceremony.id,
                newParticipantData?.tempContributionData
            )
        } else
            await multiPartUpload(
                startMultiPartUpload,
                generatePreSignedUrlsParts,
                completeMultiPartUpload,
                bucketName,
                storagePath,
                localPath
            )

        console.log(
            `${symbols.success} ${
                finalize ? `Contribution` : `Contribution ${theme.bold(`#${nextZkeyIndex}`)}`
            } correctly saved on storage`
        )

        // Make the step if not finalizing.
        if (!finalize) await makeContributionStepProgress(firebaseFunctions!, ceremony.id, true, "verification")
    } else
        console.log(
            `${symbols.success} ${
                finalize ? `Contribution` : `Contribution ${theme.bold(`#${nextZkeyIndex}`)}`
            } already saved on storage`
        )

    if (
        finalize ||
        (!!newParticipantData?.contributionStep &&
            newParticipantData?.contributionStep === ParticipantContributionStep.DOWNLOADING) ||
        newParticipantData?.contributionStep === ParticipantContributionStep.COMPUTING ||
        newParticipantData?.contributionStep === ParticipantContributionStep.UPLOADING ||
        newParticipantData?.contributionStep === ParticipantContributionStep.VERIFYING
    ) {
        // 5. Verify contribution.
        const { valid, verifyCloudFunctionTime, fullContributionTime } = await computeVerification(
            ceremony,
            circuit,
            ghUsername,
            avgTimings.verifyCloudFunction,
            firebaseFunctions
        )

        const {
            seconds: verificationSeconds,
            minutes: verificationMinutes,
            hours: verificationHours
        } = getSecondsMinutesHoursFromMillis(verifyCloudFunctionTime)

        console.log(
            `${valid ? symbols.success : symbols.error} ${
                finalize ? `Contribution` : `Contribution ${theme.bold(`#${nextZkeyIndex}`)}`
            } ${valid ? `is ${theme.bold("VALID")}` : `is ${theme.bold("INVALID")}`}`
        )
        console.log(
            `${symbols.success} ${
                finalize ? `Contribution` : `Contribution ${theme.bold(`#${nextZkeyIndex}`)}`
            } verification took ${theme.bold(
                `${convertToDoubleDigits(verificationHours)}:${convertToDoubleDigits(
                    verificationMinutes
                )}:${convertToDoubleDigits(verificationSeconds)}`
            )}`
        )

        const {
            seconds: contributionSeconds,
            minutes: contributionMinutes,
            hours: contributionHours
        } = getSecondsMinutesHoursFromMillis(fullContributionTime + verifyCloudFunctionTime)
        console.log(
            `${symbols.info} Your contribution took ${theme.bold(
                `${convertToDoubleDigits(contributionHours)}:${convertToDoubleDigits(
                    contributionMinutes
                )}:${convertToDoubleDigits(contributionSeconds)}`
            )}`
        )
    }
}
