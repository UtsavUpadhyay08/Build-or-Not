/**
 * MongoDB implementation of Store.
 *
 * Collections and why they're shaped this way:
 *   ideas       { _id: ideaId, ...brief, status, ... }        index: createdAt desc, status
 *   judgments   { _id: "ideaId:personaId", ok: bool, ... }    index: ideaId
 *   syntheses   { _id: ideaId, ... }
 *   eval_judgments { _id: "runId:condition:itemId:personaId" } index: runId
 *
 * Deterministic _ids are the key trick (replaceOne+upsert inserts the filter's _id): writing a persona's verdict is an upsert on a known _id,
 * so a retried or resumed run can never create duplicates — the write is idempotent. Successes
 * and failures share one document per persona (`ok` flag), so a later success overwrites an
 * earlier failure automatically.
 *
 * Verdicts live in their own collection rather than embedded in the idea document because they
 * arrive one at a time from concurrent workers: 45 small independent upserts, no read-modify-write
 * contention on one big document, and no 16MB-document ceiling for future larger panels.
 */
import { MongoClient, type Collection, type Db } from "mongodb";
import type { IdeaRecord, IdeaStatus, PersonaFailure, PersonaVerdict, Synthesis } from "../types.js";
import type { EvalJudgment } from "../eval/types.js";
import { evalKey, type Store } from "./store.js";

type IdeaDoc = Omit<IdeaRecord, "id"> & { _id: string };
type JudgmentDoc = { _id: string; ok: true; data: PersonaVerdict; ideaId: string; createdAt: string } | { _id: string; ok: false; data: PersonaFailure; ideaId: string; createdAt: string };
type SynthesisDoc = Synthesis & { _id: string };
type EvalDoc = EvalJudgment & { _id: string };
type QuotaDoc = { _id: string; n: number; expiresAt: Date };

export class MongoStore implements Store {
  private constructor(
    private readonly client: MongoClient,
    private readonly ideas: Collection<IdeaDoc>,
    private readonly judgments: Collection<JudgmentDoc>,
    private readonly syntheses: Collection<SynthesisDoc>,
    private readonly evalJudgments: Collection<EvalDoc>,
    private readonly quotas: Collection<QuotaDoc>,
  ) {}

  static async connect(uri: string): Promise<MongoStore> {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    const db: Db = client.db(databaseName(uri));
    const store = new MongoStore(
      client,
      db.collection<IdeaDoc>("ideas"),
      db.collection<JudgmentDoc>("judgments"),
      db.collection<SynthesisDoc>("syntheses"),
      db.collection<EvalDoc>("eval_judgments"),
      db.collection<QuotaDoc>("quotas"),
    );
    await store.ensureIndexes();
    return store;
  }

  private async ensureIndexes(): Promise<void> {
    await Promise.all([
      this.ideas.createIndex({ createdAt: -1 }),
      this.ideas.createIndex({ status: 1 }),
      this.judgments.createIndex({ ideaId: 1 }),
      this.evalJudgments.createIndex({ runId: 1 }),
      // Counters delete themselves when their day is over. (Some Mongo-compatible servers lack TTL
      // indexes; expired buckets are also ignored in code, so that only costs a little disk.)
      this.quotas.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => undefined),
    ]);
  }

  async insertIdea(idea: IdeaRecord): Promise<void> {
    const { id, ...rest } = idea;
    await this.ideas.insertOne({ _id: id, ...rest });
  }

  async getIdea(id: string): Promise<IdeaRecord | null> {
    const doc = await this.ideas.findOne({ _id: id });
    return doc ? fromIdeaDoc(doc) : null;
  }

  async listIdeas(limit = 200): Promise<IdeaRecord[]> {
    const docs = await this.ideas.find().sort({ createdAt: -1 }).limit(limit).toArray();
    return docs.map(fromIdeaDoc);
  }

  async findIdeasByStatus(status: IdeaStatus): Promise<IdeaRecord[]> {
    return (await this.ideas.find({ status }).toArray()).map(fromIdeaDoc);
  }

  async updateIdeaStatus(id: string, status: IdeaStatus, error: string | null = null): Promise<void> {
    await this.ideas.updateOne({ _id: id }, { $set: { status, error } });
  }

  async deleteIdea(id: string): Promise<void> {
    await Promise.all([this.judgments.deleteMany({ ideaId: id }), this.syntheses.deleteOne({ _id: id }), this.ideas.deleteOne({ _id: id })]);
  }

  async saveVerdict(v: PersonaVerdict): Promise<void> {
    const _id = `${v.ideaId}:${v.personaId}`;
    await this.judgments.replaceOne({ _id }, { ok: true, data: v, ideaId: v.ideaId, createdAt: v.createdAt }, { upsert: true });
  }

  async saveFailure(f: PersonaFailure): Promise<void> {
    const _id = `${f.ideaId}:${f.personaId}`;
    // Never let a failure overwrite a success that landed first (e.g. a duplicate resumed worker).
    await this.judgments.replaceOne({ _id, ok: { $ne: true } } as any, { ok: false, data: f, ideaId: f.ideaId, createdAt: f.createdAt }, { upsert: true }).catch((err) => {
      if (err?.code !== 11000) throw err; // duplicate key = a success already exists; that's fine
    });
  }

  async getVerdicts(ideaId: string): Promise<PersonaVerdict[]> {
    const docs = await this.judgments.find({ ideaId, ok: true }).sort({ createdAt: 1 }).toArray();
    return docs.map((d) => d.data as PersonaVerdict);
  }

  async getFailures(ideaId: string): Promise<PersonaFailure[]> {
    const docs = await this.judgments.find({ ideaId, ok: false }).toArray();
    return docs.map((d) => d.data as PersonaFailure);
  }

  async saveSynthesis(s: Synthesis): Promise<void> {
    await this.syntheses.replaceOne({ _id: s.ideaId }, s, { upsert: true });
  }

  async getSynthesis(ideaId: string): Promise<Synthesis | null> {
    const doc = await this.syntheses.findOne({ _id: ideaId });
    return doc ? stripId(doc) : null;
  }

  async getSyntheses(ideaIds: string[]): Promise<Map<string, Synthesis>> {
    const docs = await this.syntheses.find({ _id: { $in: ideaIds } }).toArray();
    return new Map(docs.map((d) => [d._id, stripId(d)]));
  }

  async saveEvalJudgments(js: EvalJudgment[]): Promise<void> {
    if (js.length === 0) return;
    await this.evalJudgments.bulkWrite(
      js.map((j) => {
        const _id = evalKey(j);
        return { replaceOne: { filter: { _id }, replacement: j, upsert: true } };
      }),
      { ordered: false },
    );
  }

  async getEvalJudgments(runId: string): Promise<EvalJudgment[]> {
    return (await this.evalJudgments.find({ runId }).toArray()).map(stripId);
  }

  async evalDoneKeys(runId: string): Promise<Set<string>> {
    const docs = await this.evalJudgments.find({ runId }, { projection: { _id: 1 } }).toArray();
    return new Set(docs.map((d) => d._id));
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * One atomic statement: increment only while under the limit. When the limit is reached the
   * filter matches nothing, the upsert tries to insert a second doc with the same _id, and Mongo
   * refuses (E11000), which means "no". Two simultaneous requests can never both get the last run.
   */
  async takeQuota(bucket: string, limit: number, expiresAt: Date): Promise<number | null> {
    if (limit <= 0) return null;
    try {
      const doc = await this.quotas.findOneAndUpdate(
        { _id: bucket, n: { $lt: limit } },
        { $inc: { n: 1 }, $setOnInsert: { expiresAt } },
        { upsert: true, returnDocument: "after" },
      );
      return doc?.n ?? 1;
    } catch (err) {
      if ((err as { code?: number }).code === 11000) return null;
      throw err;
    }
  }

  async returnQuota(bucket: string): Promise<void> {
    await this.quotas.updateOne({ _id: bucket, n: { $gt: 0 } }, { $inc: { n: -1 } });
  }

  async quotaUsed(bucket: string): Promise<number> {
    const doc = await this.quotas.findOne({ _id: bucket });
    return doc && doc.expiresAt > new Date() ? doc.n : 0;
  }
}

function fromIdeaDoc({ _id, ...rest }: IdeaDoc): IdeaRecord {
  return { id: _id, ...rest };
}

function stripId<T extends { _id: string }>({ _id, ...rest }: T): Omit<T, "_id"> {
  return rest;
}

/**
 * The database named in the URI path (`...mongodb.net/build-or-not?...`), or "build-or-not" when the
 * path is empty. Without this, a URI copied straight from Atlas (which has no path) silently uses
 * "test", and a user who may only write to one database gets "not allowed to do action".
 */
export function databaseName(uri: string): string {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/[^/?]+\/([^?]*)/);
  const name = m?.[1] ? decodeURIComponent(m[1]) : "";
  return name || "build-or-not";
}

/** The URI with the username and password hidden, safe to print in logs. */
export function redactMongoUri(uri: string): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/)[^@/]*@/, "$1***:***@");
}
