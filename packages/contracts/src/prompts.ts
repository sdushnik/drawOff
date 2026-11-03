export const PROMPTS = [
  "cat astronaut",
  "haunted toaster",
  "pizza volcano",
  "dragon at the dentist",
  "lighthouse",
  "octopus chef",
  "melting clock",
  "robot gardener",
  "snowman on vacation",
  "giraffe in a scarf",
  "flying whale",
  "tiny house",
  "angry cloud",
  "skateboarding dog",
  "treasure map",
  "ice cream monster",
  "wizard hat",
  "submarine",
  "cactus with a hat",
  "rocket launch",
  "sleepy owl",
  "banana phone",
  "castle in the sky",
  "penguin party",
  "time machine",
  "jellyfish disco",
  "bicycle",
  "mermaid",
  "volcano",
  "ghost selfie",
] as const;

/** Pick `count` distinct prompts, preferring ones not in `avoid`. */
export function pickSuggestions(
  random: () => number,
  count = 3,
  avoid: ReadonlySet<string> = new Set(),
): string[] {
  const fresh = PROMPTS.filter((prompt) => !avoid.has(prompt));
  const pool = fresh.length >= count ? [...fresh] : [...PROMPTS];
  const picked: string[] = [];
  while (picked.length < count && pool.length > 0) {
    const sample = random();
    const index = Number.isFinite(sample)
      ? Math.min(pool.length - 1, Math.max(0, Math.floor(sample * pool.length)))
      : 0;
    picked.push(pool.splice(index, 1)[0]!);
  }
  return picked;
}
