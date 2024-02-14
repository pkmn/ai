interface Versions {
  agent: number;
  id: number;
}

interface Battles {
  id: number;
  format: number;
  p1: number;
  p2: number;
  rating: string;
}

export class Pool {
  private participants: number[];

  // FIXME all should be heaps -> max rating, array of heaps of min battles, min total battles
  private ratings: number[]; // Heap<number>;
  private battles: number[][]; // Heap<number>[];
  private totals: number[]; // Heap<number>;

  // Determines eligible participants for the matchmaking pool and computes the total number of
  // battles between each participant. The latest version as well as the the highest-rated prior
  // version (if any) of each agent is considered eligible
  constructor(versions: Versions[], battles: Battles[]) {
  // The raw aggregated information gleaned from the database - we could probably compute this
  // with SQL and that might be warranted but given we should only be running this function once
  // at server startup it's less important to push this down into the database
    const all: {ratings: number[]; battles: number[][]} = {
      ratings: new Array(versions.length),
      battles: new Array(versions.length).fill(new Array(versions.length)),
    };
    for (const row of all.battles) row.fill(0);

    // SELECT id FROM versions GROUP BY agent -- all the versions for each agent
    const agents: {[id: number]: number[]} = {};
    for (const battle of battles) {
    // The battles matrix is symmetrical with zeros on the diagonal so this could be optimized, but
    // its all O(n^2) anyway and we don't really care about the constant factor given the note above
    // about how (in)frequently this should be executed
      all.battles[battle.p1][battle.p2]++;
      all.battles[battle.p2][battle.p1]++;

      agents[versions[battle.p1].agent] ||= [];
      agents[versions[battle.p1].agent].push(battle.p1);
      agents[versions[battle.p2].agent] ||= [];
      agents[versions[battle.p2].agent].push(battle.p2);

      const rating = JSON.parse(battle.rating);
      all.ratings[rating.p1.gxe] = rating.p1.gxe;
      all.ratings[rating.p2.gxe] = rating.p2.gxe;
    }

    this.participants = [];
    for (const id in agents) {
    // PRECONDITION: id1 > id2 => versions[id1].created_at > versions[id2].created_at.
    // It should already be the case that the array of versions is in ascending order but it's
    // not guaranteed anywhere so we sort again (and sorting an already sorted list should be fast)
      const agent = agents[id].sort((a, b) => a - b);
      const latest = agent.pop()!;
      this.participants.push(latest);
      let best = 0;
      for (const version of agent) {
        if (all.ratings[version] > best) best = all.ratings[version];
      }
      if (best) this.participants.push(best);
    }

    // Not actually required for any semantic reason but should make debugging slightly nicer
    this.participants.sort();

    this.ratings = new Array(this.participants.length);
    this.battles = new Array(this.participants.length).fill(new Array(this.participants.length));
    this.totals = new Array(this.participants.length).fill(0);

    // Determine the mapping of version id to index in the participants array
    const mapping: {[id: number]: number} = {};
    for (const [i, participant] of this.participants.entries()) {
      this.ratings[i] = all.ratings[participant];
      mapping[participant] = i;
    }

    for (let i = 0; i < this.participants.length; i++) {
      this.battles[i] = new Array(this.participants.length);
      for (let j = 0; j < this.participants.length; j++) {
        const n = all.battles[mapping[this.participants[i]]][mapping[this.participants[j]]];
        this.battles[i][j] = n;
        this.totals[i] += n;
      }
    }
  }

  next() {
    // TODO iterator
    throw new Error('Unimplemented');
  }

  update() {
    // TODO take battle result and update matrix (precondition must be in participants)
    throw new Error('Unimplemented');
  }
}

type Comparator<T> = (a: T, b: T) => number;

// FIXME want index AND value
// https://github.com/ignlg/heap-js/blob/master/src/Heap.ts
export class Heap<T> implements Iterable<T> {
  data: T[] = [];
  compare: Comparator<T>;

  constructor(compare: Comparator<T>) {
    this.compare = compare;
  }

  replace(element: T): T {
    const peek = this.data[0];
    this.data[0] = element;
    this.sortNodeDown(0);
    return peek;
  }

  pop(): T | undefined {
    const last = this.data.pop();
    if (this.data.length > 0 && last !== undefined) {
      return this.replace(last);
    }
    return last;
  }

  *[Symbol.iterator](): Iterator<T> {
    while (this.data.length) {
      yield this.pop() as T;
    }
  }

  static getChildrenIndexOf(idx: number): Array<number> {
    return [idx * 2 + 1, idx * 2 + 2];
  }

  private sortNodeDown(i: number): void {
    let moveIt = i < this.data.length - 1;
    const self = this.data[i];

    const getPotentialParent = (best: number, j: number) => {
      if (this.data.length > j && this.compare(this.data[j], this.data[best]) < 0) {
        best = j;
      }
      return best;
    };

    while (moveIt) {
      const childrenIdx = Heap.getChildrenIndexOf(i);
      const bestChildIndex = childrenIdx.reduce(getPotentialParent, childrenIdx[0]);
      const bestChild = this.data[bestChildIndex];
      if (typeof bestChild !== 'undefined' && this.compare(self, bestChild) > 0) {
        this.swap(i, bestChildIndex);
        i = bestChildIndex;
      } else {
        moveIt = false;
      }
    }
  }

  private swap(i: number, j: number): void {
    [this.data[i], this.data[j]] = [this.data[j], this.data[i]];
  }
}
