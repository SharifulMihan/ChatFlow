/**
 * test_overlap_algorithm.js
 */

function isRowMatch(a, b) {
  if (a.domId && b.domId) return a.domId === b.domId;
  return a.sender === b.sender && a.type === b.type && a.text === b.text;
}

function mergeSnapshot(masterList, snapshot) {
  if (masterList.length === 0) {
    masterList.push(...snapshot);
    return { overlap: 0, appended: snapshot.length };
  }

  const maxK = Math.min(snapshot.length, masterList.length);
  let bestK = 0;

  for (let k = maxK; k >= 1; k--) {
    let match = true;
    for (let i = 0; i < k; i++) {
      const mIdx = masterList.length - k + i;
      if (!isRowMatch(masterList[mIdx], snapshot[i])) {
        match = false;
        break;
      }
    }
    if (match) {
      bestK = k;
      break;
    }
  }

  if (bestK > 0) {
    // Merge metadata on overlapping rows
    for (let i = 0; i < bestK; i++) {
      const mItem = masterList[masterList.length - bestK + i];
      const sItem = snapshot[i];
      if (sItem.reactions && sItem.reactions.length > 0) {
        mItem.reactions = Array.from(new Set([...(mItem.reactions || []), ...sItem.reactions]));
      }
      if (!mItem.timestamp && sItem.timestamp) {
        mItem.timestamp = sItem.timestamp;
      }
    }

    const toAppend = snapshot.slice(bestK);
    masterList.push(...toAppend);
    return { overlap: bestK, appended: toAppend.length };
  }

  return { overlap: 0, appended: 0 }; // No overlap
}

// Test 1: Simple overlap
const master1 = [
  { sender: 'Nadira', type: 'text', text: 'Hello' },
  { sender: 'Me', type: 'text', text: 'Hi' },
  { sender: 'Nadira', type: 'text', text: 'How are you?' }
];
const snap1 = [
  { sender: 'Me', type: 'text', text: 'Hi' },
  { sender: 'Nadira', type: 'text', text: 'How are you?' },
  { sender: 'Me', type: 'text', text: 'Good thanks' }
];
const r1 = mergeSnapshot(master1, snap1);
console.assert(r1.overlap === 2, `Expected overlap 2, got ${r1.overlap}`);
console.assert(r1.appended === 1, `Expected appended 1, got ${r1.appended}`);
console.assert(master1.length === 4, `Expected 4 messages, got ${master1.length}`);
console.assert(master1[3].text === 'Good thanks');

// Test 2: Identical consecutive messages preserved!
const master2 = [
  { sender: 'Me', type: 'text', text: 'Ok' },
  { sender: 'Me', type: 'text', text: 'Ok' },
  { sender: 'Me', type: 'text', text: 'Ok' },
  { sender: 'Nadira', type: 'text', text: 'Fine' }
];
const snap2 = [
  { sender: 'Me', type: 'text', text: 'Ok' },
  { sender: 'Nadira', type: 'text', text: 'Fine' },
  { sender: 'Me', type: 'text', text: 'Bye' }
];
const r2 = mergeSnapshot(master2, snap2);
console.assert(r2.overlap === 2, `Expected overlap 2, got ${r2.overlap}`);
console.assert(master2.length === 5, `Expected 5 messages, got ${master2.length}`);
console.assert(master2.filter(m => m.text === 'Ok').length === 3, 'All 3 Ok messages must be preserved');

console.log('Snapshot overlap tests passed successfully!');
