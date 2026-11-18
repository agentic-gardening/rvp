// Prints what the model thinks, says and runs, as it happens: node rvp/follow.mjs <pi session folder> [--new]
// pi appends one JSON line per message to the files of that folder. --new skips what is already there.
// Every printed line starts with a marker, so nothing the model writes can be read as a workflow command.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [dir, flag] = process.argv.slice(2);
const seen = new Map(); // file -> lines already handled
const shown = new Set(); // ids of the commands whose output is worth showing
const clean = text => String(text ?? '').replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[^\x09\x0a\x20-\x7e -￿]/g, '');
const say = (mark, text) => clean(text).split('\n').map(l => l.trimEnd()).filter(Boolean).forEach(l => console.log(`${mark} ${l}`));

function show({ role, content, toolCallId }) {
  for (const part of Array.isArray(content) ? content : []) {
    if (role === 'assistant' && part.type === 'thinking') say('💭', part.thinking);
    if (role === 'assistant' && part.type === 'text') say('💬', part.text);
    if (role === 'assistant' && part.type === 'toolCall') {
      const { command, path } = part.arguments ?? {};
      // actions on the app are already printed in plain words from progress.log
      if (part.name === 'bash' && /rvp\/pd\.mjs/.test(command ?? '')) continue;
      if (part.name === 'bash') shown.add(part.id);
      say('$', part.name === 'bash' ? command : `${part.name} ${path ?? ''}`);
    }
    if (role === 'toolResult' && shown.has(toolCallId) && part.type === 'text') {
      const lines = clean(part.text).split('\n').filter(l => l.trim());
      say('  |', lines.slice(0, 15).join('\n'));
      if (lines.length > 15) console.log(`  | … ${lines.length - 15} more lines`);
    }
  }
}

function poll(print) {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    const lines = readFileSync(join(dir, file), 'utf8').split('\n');
    lines.pop(); // the last piece is empty, or a line still being written
    for (const line of lines.slice(seen.get(file) ?? 0)) {
      try {
        const entry = JSON.parse(line);
        if (print && entry.type === 'message') show(entry.message);
      } catch {} // not a message
    }
    seen.set(file, lines.length);
  }
}

poll(flag !== '--new');
setInterval(() => poll(true), 200);
