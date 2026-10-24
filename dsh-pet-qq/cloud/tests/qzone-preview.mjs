import { generateMood } from '../lib/proactive.mjs';
import { cleanMood } from '../lib/qzone.mjs';
import { personaFor } from '../lib/pet-api.mjs';

const pet = await personaFor('private');
const mood = { valence: 0.3, arousal: 0.4, clingy: 0.2 };
for (let i = 1; i <= 3; i++) {
  const r = await generateMood({ pet, now: new Date(), history: [], mood, maxChars: 90 });
  console.log(`#${i} ok=${r.ok} say=${JSON.stringify(r.say)} clean=${JSON.stringify(cleanMood(r.say || '', 90))} think=${JSON.stringify(r.think || '')}`);
}
