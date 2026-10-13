import { readMainArtifact } from './main-artifact.mjs';

// A job output pins the entire source declaration independently. Consumers may
// not replace both archive bytes and their self-declared digest together.
const artifact = await readMainArtifact();
console.log(`main_source_sha256=${artifact.sourceSha256}`);
