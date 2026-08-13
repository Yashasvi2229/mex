const CONTROL_OPERATOR = /(?:\r|\n|&&|\|\||[;|<>`]|\$\()/;
const SQLITE = /\b(?:sqlite3?|better-sqlite3|graph\.db(?:-wal|-shm)?)\b/i;

export function shellQuote(word) {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

export function shellWords(command) {
  const words = [];
  let word = "", quote = null, escaped = false;
  for (const char of command.trim()) {
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (word) { words.push(word); word = ""; } continue; }
    word += char;
  }
  if (quote || escaped) throw new Error("unterminated shell quoting");
  if (word) words.push(word);
  return words;
}

function startsWith(words, prefix) {
  return prefix.every((word, index) => words[index] === word);
}

export function validateTranscriptPolicy(toolCalls, armId, arm, armCommands) {
  const violations = [];
  const graphCommandOwners = Object.entries(armCommands);
  const graphCalls = [];
  for (const call of toolCalls) {
    const serializedInput = JSON.stringify(call.input ?? {});
    if (SQLITE.test(serializedInput)) violations.push(`raw SQLite access through ${call.name}`);
    if (call.name !== "Bash") continue;
    const command = String(call.input?.command ?? "").trim();
    if (arm.kind === "grep") { violations.push("grep arm used Bash"); continue; }
    if (CONTROL_OPERATOR.test(command)) { violations.push(`shell control operator: ${command}`); continue; }
    if (SQLITE.test(command)) { violations.push(`raw SQLite access: ${command}`); continue; }
    let words;
    try { words = shellWords(command); } catch (error) { violations.push(error.message); continue; }
    const own = armCommands[armId];
    if (!startsWith(words, own)) {
      const crossArm = graphCommandOwners.find(([id, prefix]) => id !== armId && startsWith(words, prefix));
      violations.push(crossArm ? `cross-arm binary (${crossArm[0]}): ${command}` : `unrelated Bash command: ${command}`);
      continue;
    }
    const args = words.slice(own.length);
    const commandKey = args[0] === "impact" ? "impact" : `${args[0] ?? ""} ${args[1] ?? ""}`.trim();
    const allowed = arm.vocabRetry
      ? new Set(["graph scope", "graph query", "graph get", "graph vocab", "impact"])
      : new Set(["graph scope", "graph query", "graph get", "impact"]);
    if (!allowed.has(commandKey)) violations.push(`disallowed graph command: ${command}`);
    else graphCalls.push(commandKey);
  }
  if (arm.kind === "graph" && graphCalls[0] !== "graph scope") violations.push("graph arm did not start with graph scope");
  if (graphCalls.filter((command) => command === "graph vocab").length > 1) violations.push("more than one graph vocab call");
  if (!arm.vocabRetry && graphCalls.includes("graph vocab")) violations.push("baseline arm used graph vocab");
  return violations;
}
