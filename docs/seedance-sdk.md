# Seedance video example

The checked-in [`index.ts`](../index.ts) is a server-side example for Higgsfield Seedance 2.5 text-to-video. It submits the prompt `A cinematic scene at sunset` for a five-second, 720p, 16:9 clip and waits for a terminal result with the TypeScript v2 SDK's `higgsfield.subscribe()` and `withPolling: true`.

## Local setup

Node.js 22 or later, pnpm, and the repository dependencies are required.

1. Put `HF_CREDENTIALS=key-id:key-secret` in the ignored root `.env.local` file. Never expose or commit the value. The SDK runs only on the server.
2. Run the example once with `pnpm example:seedance`.
3. A completed result with a video URL prints that URL. Failed, canceled, moderated, or URL-less results exit with an error.

To generate the original five-second teaser, run `pnpm media:generate-intro` once. It requests one clip and saves a validated response to `public/media/handsel-intro.mp4`.

## Product explainer film

The landing page uses a 58-second film built from six sequential, ten-second Seedance 2.5 API requests. `pnpm media:generate-explainer` submits the six distinct shots one at a time through the same server-side SDK, waits for `completed`, checks the returned URL and video MIME, and saves the raw clips to ignored `var/higgsfield/handsel-explainer-scenes/`. If any request or download fails, it exits without retrying or submitting later scenes. Resolve the issue before deciding whether to launch new paid requests; generated files block duplicate scene requests.

Once all six clips exist, `pnpm media:assemble-explainer` uses `ffmpeg-static` to normalize and cross-fade them, burn in the written product captions, and create the poster. It writes the landing asset to `public/media/handsel-explainer.mp4`; raw clips remain local and ignored so they are not shipped as duplicate public downloads. The six requests use 720p, 16:9, ten seconds each, with generated audio disabled. At the listed starting rate of US$0.144 per second, 60 seconds is approximately US$8.64; check the current API billing page before launching a new batch.

The [official SDK guide](https://docs.higgsfield.ai/docs/how-to/sdk) documents `@higgsfield/client/v2`, server-side `HF_CREDENTIALS`, and `withPolling`. The [Seedance 2.5 API reference](https://console.higgsfield.ai/models/bytedance/seedance-2.5/text-to-video/api-reference) documents the model ID, duration bounds, input fields, and `video` result field.
