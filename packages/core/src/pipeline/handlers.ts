import type { HandlerRegistry } from "@clipfactory/queue";
import type { PipelineContext } from "./context.js";
import {
  runCallGenerate,
  runDetect,
  runDownload,
  runCookGenerate,
  runEnhance,
  runPublish,
  runRender,
  runStoryGenerate,
  runTranscribe,
} from "./stages.js";

/** Maps each queue to its stage function, closing over the pipeline context. */
export function buildHandlers(ctx: PipelineContext): HandlerRegistry {
  return {
    "video.download": (p) => runDownload(ctx, p.sourceVideoId),
    "video.transcribe": (p) => runTranscribe(ctx, p.sourceVideoId),
    "clip.detect": (p) => runDetect(ctx, p.sourceVideoId),
    "clip.render": (p) => runRender(ctx, p.clipId),
    "clip.enhance": (p) => runEnhance(ctx, p.clipId),
    "story.generate": (p) => runStoryGenerate(ctx, p.sourceVideoId),
    "cook.generate": (p) => runCookGenerate(ctx, p.sourceVideoId),
    "call.generate": (p) => runCallGenerate(ctx, p.sourceVideoId),
    "publish.execute": (p) => runPublish(ctx, p.publishJobId),
  };
}
