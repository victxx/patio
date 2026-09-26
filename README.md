# Patio — Tokyo26

An experiment in open information, and a project that helped shape my life.

## Why I am bringing Patio back

Patio is part of why I am where I am today — both professionally and personally. It helped me find my way in the ecosystem, taught me more than I could have imagined, and introduced me to people who became great friends.

Being here in Tokyo is part of that journey. This hackathon feels like the right moment to bring Patio back to life and give something back to a project, and a community, that have given me so much.

## What it stands for

Everyone should be able to access information freely. For people who cannot, that freedom can make a real difference.

Patio is my small contribution toward that possibility and a fairer world. That is what makes this personal, beyond any demo or hackathon.

## The technical idea

The original PAT.IO station explored using Ethereum transaction data and the mempool to distribute audio and video.

Its documented proof-of-concept flow was:

1. **Encode:** convert a media file to Base64, add markers identifying the content, and encode the result as hex.
2. **Broadcast:** split the payload into chunks carried by transactions from a broadcaster's station address.
3. **Listen:** watch pending transactions associated with that address through a mempool data provider.
4. **Reconstruct:** collect the payloads, detect the content boundaries, decode the media, and play it in the browser.

The repository contains early HTML/JavaScript interfaces, media conversion scripts, and a Node.js/Express backend using ethers. These are the starting materials for the revival; the end-to-end flow still needs to be verified for this new chapter.

## The Tokyo26 starting point

- Recover a runnable baseline and check which parts of the original experiment still work.
- Gradually bring in selected components from the other repository, with a clear purpose for each commit.
- Revisit transaction handling, mempool access, payload reconstruction, and key management as we rebuild.
- Define a focused demo around what we can validate during the hackathon.

Development will happen on `tokyo26`. This first commit records the motivation and starting direction; implementation will follow step by step.

## Protocol workspace

The original prototype, design assets, screenshots, and building notes are grouped under [`legacy/`](legacy/). New development lives in `packages/`.

The first UI experiment lives in [`apps/radio-test/`](apps/radio-test/). Open `index.html` directly in a browser to try the placeholder station screen.

`packages/protocol` currently contains the `PatioPacketV1` types, message and codec identifiers, packet envelope constants, and byte/Base64 conversion helpers. Packet encoding, decoding, and network transport are not implemented in this workspace yet.

Use Node.js 24 and pnpm 11.19.0 to install dependencies, check the TypeScript definitions, and run the conversion tests:

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
```

---

<details>
<summary>Original prototype documentation</summary>

# PAT.IO station

## CAST PAGE BEHAVIOUR

1º Caster submits a 'private_key' to an API and receives as response a 'public_address' (station address) that will be shown in the frontend. This private_key will be securely used by the backend to send the casting transactions. We need to do this in this Proof of Concept because wallets are slow to build and confirm transactions.

2º Caster will select a source to cast from, for this Proof of Concepto should be a mp4 video or mp3 audio format. This is submited in base64, adding the prefix 'PATIOstationAudio_' OR 'PATIOstationVideo_' and the suffix '_stationPATIO' and submits to the backend (API) through a _POST request.

3º The API will receive this ASCII message, converts it into HEX data, split it into 25 kilobytes 'blocks' and write it into a database table that is designed as follows:

 | autoincremental_id | HEX_data | gas_price | priority_fee | nonce | state | tx_hash | caster_identifier |
 |--------------------|----------|-----------|--------------|-------|-------|---------|-------------------|
```
HEX_data            The HEX_data to broadcast
gas_price           Starts at 1.1 and goes up by 10% up to 10, once is reached an empty HEX_data transaction (the last one) it will be sent and nonce moves to the next one for the next interaction.
priority_fee        Starts at 100 and goes up by 10% until nonce changes, no decimal values since is wei.
state               Is 0 if is not handled, is 2 if is being processed, is 1 if is completed.
caster_identifier   The private_key access information, we are not taking high security considerations in this DEMO because is a proof of concept, not neccessary.
```
4º A script that runs continuously reads this database table and processes the first available transaction for each Caster with state '0' and changes the state to '2'. BUT this happens only if there is no one in state '2', if not it will wait until the next one is at 0. When a transaction that was on '0' and then changed to '2' si completed, the states changes to 1.

5º Caster see in the frontend right boxes: Blocknative API with the streaming information (check-back) and received donations.

## TUNE IN PAGE BEHAVIOUR

1º The Viewer is consuming a node API (Blocknative) hearing the station address which checks continuously. The API is a service that is hearing the Mempool directly from a webhook and giving the frontend only the tx_hash and the HEX_data content of the transaction, which will be used by the frontend (no pre-processing to avoid speculations) and decoded to see the streamed media, for the live demo we'll use video streaming.

2º Once a new content is arriving it will be detected by the front-end dApp reading the HEX_data package starting with the prefix signature '504154494F73746174696F6E566', then it will start to "build" the streming information and wait the finalization of the streaming when the suffix '5F73746174696F6E504154494F' is found.

3º For processing the frontend which has a built in HTML player will use JavaScript to remove the prefix and suffix to leave the HEX information ready to be converted to from HEX to base64, removing the 0x from each received package as well, and then converted from base64 to the binary needed to be processed by the browser.

4º Then it converts the 'base64' to the file to play, showing the right DIV (for audioplayer or videoplayer) inside the playing box.

5º For this demo the TUNE-IN page will show the audio or video version of the player depending on the detected incoming streaming.

</details>
