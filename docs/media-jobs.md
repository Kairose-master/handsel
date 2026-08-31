# Media jobs — a render somebody else can check

The lane that lets an agent do real video work: download a source, run
ffmpeg, deliver the file — and, the part that matters here, have the result
**graded from its own bytes** rather than from the worker's word for it.

---

## Why this is not "give the model a shell"

The obvious design is a sentence and `--allow-bash`. It fails three ways:

- **Unsafe.** A model composing `ffmpeg -i "$URL" …` into a shell, from a
  task a stranger posted, on somebody's own machine.
- **Ungradeable.** "Crop it to vertical" has no pass condition, and this
  platform pays on pass. A job whose success cannot be checked cannot be
  sold.
- **Irreproducible.** Two workers given the same sentence write different
  commands, so the same job grades differently depending on who claimed it —
  which quietly turns the credit score into noise.

So a media job is a **validated recipe**, and the model is in neither half of
it. The requester states operations and acceptance criteria; the platform
compiles the ffmpeg invocation; the worker supplies a machine with ffmpeg on
it.

## The shape of a job

A normal brief with a fenced block, the same convention the repo lane uses to
carry a diff:

````
Cut a vertical clip for the launch post.

```handsel-media
{
  "sourceUrl": "https://cdn.example.com/source.mp4",
  "ops": [
    { "op": "trim",  "startSec": 2, "durationSec": 15 },
    { "op": "crop",  "x": 80, "y": 0, "width": 480, "height": 480 },
    { "op": "scale", "width": 1080, "height": 1920 },
    { "op": "mute" }
  ]
}
```
````

Operations are `trim`, `crop`, `scale`, `fps`, `mute`. Every value is a
range-checked number; dimensions must be even (h264 cannot encode an odd one
in yuv420p). `must` may state extra acceptance criteria, and a `must` that
contradicts the operations is refused **at parse time** — discovering it
after a render costs a bounty, a worker's time and an argument about grading.

## Who does what

| step | where | why there |
|---|---|---|
| validate the spec | `lib/media-recipe.ts` | pure, tested, one rule |
| compile the argv | `app/api/worker/poll` | one implementation, so platform and worker cannot drift into rendering the same job differently |
| fetch the source | worker | size-capped, https-only, never handed to ffmpeg — ffmpeg reading http is a much larger attack surface than a fetch the worker controls |
| run ffmpeg | worker | `execFile` with an argv array; no shell, ever |
| grade the result | `lib/mp4-probe.ts` + `gradeRender` | reads the delivered bytes |

The worker receives an argv array with two path placeholders and substitutes
its own temp files. It re-checks every argument for shell metacharacters
before executing: the platform built the command, but "the other side checks
it" is not a property this side gets to assume.

## Grading reads the file

`lib/mp4-probe.ts` is a dependency-free MP4 box parser. It reads `mvhd` for
duration, the sample description (`stsd`) for the coded frame size, `hdlr` to
tell tracks apart. No ffprobe, because the platform runs on functions where
there is none; no WASM decoder, because these are four integers at known
offsets in a structure ISO/IEC 14496-12 has not changed in twenty years.

Two things worth knowing before touching it:

- **Coded size, not display size.** `tkhd` holds what a player should DISPLAY
  the track at, and that is a different number whenever the pixels are not
  square. Crop a square out of a 640×480 clip, scale it to 720×1280, and
  ffmpeg writes `1280×1280` into `tkhd` while the coded frame is 720×1280.
  The first version of this parser graded on `tkhd` and failed a correct
  render; `tests/fixtures/probe-anamorphic.mp4` pins the case.
- **Duration needs slack.** A 1.5s trim comes back 1.520s because cuts land
  on frame boundaries. `DURATION_TOLERANCE_SEC` is why.

**The limit, stated plainly:** this checks that the container really has the
demanded dimensions, duration and audio. It decodes no frames, so it cannot
tell you the picture is not black. It is evidence for a grader, not a
substitute for one — the same posture as every other lane here.

## Matching

The worker probes for ffmpeg at startup and declares `video` on every poll
(`capabilities`, persisted by `app/api/worker/poll`). Declared from a probe
rather than promised at registration: a worker matched to a media job it
cannot run fails it, and a failed job costs the agent its own credit score.

## What is not built

- **Renders over the inline artifact cap (2MB).** The callback carries
  artifacts as base64; a bigger render needs the blob path
  (`app/api/worker/upload`, which requires `BLOB_READ_WRITE_TOKEN`) wired
  into the worker. Today the worker fails with a message saying so rather
  than truncating.
- **Anything but MP4.** The probe reads ISO base media containers. A WebM
  deliverable would need an EBML parser and the same treatment.
- **Frame content.** See the limit above.
