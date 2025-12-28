import type { ToolSet, TextStreamPart, StreamTextTransform } from 'ai';
import { process, type State, type Replacement } from './replace-in-stream';
import { compile } from './compile';

export function replaceInAISDKStream<TOOLS extends ToolSet = ToolSet>({
  pattern,
  replacement,
}: {
  pattern: RegExp | string;
  replacement: Replacement;
}): StreamTextTransform<TOOLS> {
  return () => {
    const prog =
      typeof pattern === 'string' ? compile(pattern) : compile(pattern.source);
    let state: State = { buffer: '', globalPos: 0 };
    let id = '';

    const emit = (
      controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>,
      text: string,
    ) => {
      if (text) controller.enqueue({ type: 'text-delta', text, id });
    };

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(chunk, controller) {
        if (chunk.type !== 'text-delta') {
          if (state.buffer) {
            const { output, state: s } = process(
              prog,
              replacement,
              state,
              '',
              true,
            );
            emit(controller, output + s.buffer);
            state = { buffer: '', globalPos: s.globalPos };
          }
          controller.enqueue(chunk);
          return;
        }

        id = chunk.id;
        const { output, state: s } = process(
          prog,
          replacement,
          state,
          chunk.text,
          false,
        );
        state = s;
        emit(controller, output);
      },

      flush(controller) {
        const { output, state: s } = process(
          prog,
          replacement,
          state,
          '',
          true,
        );
        emit(controller, output + s.buffer);
      },
    });
  };
}

// --- Ideal use cases (not yet implemented) ---
export const removeMarkdownLinks = replaceInAISDKStream({
  pattern: /\[([^\]]+)\]\([^)]+\)/g,
  replacement: '$1',
});

export const removeXmlTags = replaceInAISDKStream({
  pattern: /<\/?[a-zA-Z][^>]*>/g,
  replacement: '',
});

export const redactSecrets = (minLength = 20) =>
  replaceInAISDKStream({
    pattern: new RegExp(
      `(?:sk|pk|api|key|token|secret|password)[_-]?[a-zA-Z0-9]{${minLength},}`,
      'gi',
    ),
    replacement: '[REDACTED]',
  });

export const externalizeLinks = replaceInAISDKStream({
  pattern: /<a href="([^"]+)">/g,
  replacement: '<a href="$1" target="_blank" rel="noopener">',
});
