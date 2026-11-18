// Files on a prompt in the page: the composer's drafts while they upload, a prompt's files in the thread, and the
// paperclip, paste and drop that add them. A file uploads to this page's own node (`PUT /blobs`), which the prompt then
// names it on by hash; the node a prompt goes to fetches what it lacks.
import { useEffect, useRef, useState } from "preact/hooks";
import { type Attachment, MAX_BLOB_BYTES } from "../../blobs/attachment";
import { blobUrl, type Draft, nameFor, pastedFiles, shownInline, sizeText } from "./attach-model";
import { errorText } from "./hooks";
import { Iconoir } from "./icons";

export type Drafts = {
  drafts: Draft[];
  add(files: File[]): void;
  remove(id: number): void;
  restore(attachments: Attachment[]): void;
};

/** Frees a draft's preview when the page made it from the file; a restored draft's is the file's URL on the node. */
function revoke(d: Draft) {
  if (d.preview?.startsWith("blob:")) URL.revokeObjectURL(d.preview);
}

/**
 * The files a composer holds, each uploaded as it is added; an image previews from the file itself until it is removed
 * or the composer goes. A file with no type goes as `application/octet-stream`. `restore` puts a prompt's
 * attachments back, already uploaded.
 */
export function useDrafts(): Drafts {
  const [drafts, setDrafts] = useState<Draft[]>([]);
  // What the drafts are now, for revoking their previews outside a render.
  const latest = useRef(drafts);
  latest.current = drafts;
  const lastId = useRef(0);
  useEffect(() => () => latest.current.forEach(revoke), []);

  // A draft removed meanwhile is not there to settle: its upload's answer is dropped.
  const settle = (id: number, change: Partial<Draft>) => setDrafts((all) => all.map((d) => (d.id === id ? { ...d, ...change } : d)));
  const upload = async (d: Draft, file: File) => {
    try {
      // Refused here rather than sent: the node would refuse it after reading what it is sent.
      if (file.size > MAX_BLOB_BYTES) throw new Error("file exceeds 64 MB");
      const res = await fetch("/blobs", { method: "PUT", body: file });
      if (!res.ok) throw new Error((await res.text()) || `upload failed (${res.status})`);
      const { hash, size } = (await res.json()) as { hash: string; size: number };
      settle(d.id, { state: "done", attachment: { hash, name: d.name, type: d.type, size } });
    } catch (err) {
      settle(d.id, { state: "failed", error: errorText(err) });
    }
  };
  const draftOf = (over: Pick<Draft, "name" | "type" | "size" | "preview" | "state" | "attachment">): Draft =>
    ({ id: ++lastId.current, error: null, ...over });

  return {
    drafts,
    add(files) {
      const at = new Date();
      const added = files.map((file) => {
        const type = file.type || "application/octet-stream";
        const preview = shownInline(type) ? URL.createObjectURL(file) : null;
        return draftOf({ name: nameFor(file, at), type, size: file.size, preview, state: "uploading", attachment: null });
      });
      setDrafts((all) => [...all, ...added]);
      added.forEach((d, i) => void upload(d, files[i]!));
    },
    remove(id) {
      const gone = latest.current.find((d) => d.id === id);
      if (gone !== undefined) revoke(gone);
      setDrafts((all) => all.filter((d) => d.id !== id));
    },
    restore(attachments) {
      const back = attachments.map((a) =>
        draftOf({ name: a.name, type: a.type, size: a.size, preview: shownInline(a.type) ? blobUrl(a) : null, state: "done", attachment: a }));
      setDrafts((all) => [...all, ...back]);
    },
  };
}

/**
 * Paste and drop for a composer (`on`: whether it takes files at all). A paste of files with no plain text beside them
 * (`pastedFiles`), and files dropped on it, go to `onFiles`; a text paste or a text dragged within it is left to the
 * browser. `dragging`: files are over it.
 */
export function useFileTarget(onFiles: (files: File[]) => void, on: boolean) {
  const [over, setOver] = useState(false);
  const carriesFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files") === true;
  if (!on) return { dragging: false, handlers: {} };
  return {
    dragging: over,
    handlers: {
      onPaste(e: ClipboardEvent) {
        const clip = e.clipboardData;
        const files = clip === null ? [] : pastedFiles({ text: clip.getData("text/plain"), files: Array.from(clip.files) });
        if (files.length === 0) return;
        e.preventDefault();
        onFiles(files);
      },
      onDragOver(e: DragEvent) {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        setOver(true);
      },
      onDragLeave(e: DragEvent) {
        // Leaving for one of its own children is still over it.
        if (!(e.currentTarget as Node).contains(e.relatedTarget as Node | null)) setOver(false);
      },
      onDrop(e: DragEvent) {
        if (!carriesFiles(e)) return;
        e.preventDefault();
        setOver(false);
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length > 0) onFiles(files);
      },
    },
  };
}

/** The composer's files in a row: an image as its thumbnail, any other file by name and size; each with a ×. */
export function DraftChips({ drafts, onRemove }: { drafts: Draft[]; onRemove(id: number): void }) {
  if (drafts.length === 0) return null;
  return (
    <div class="attachments drafts">
      {drafts.map((d) => (
        <span key={d.id} class={`att ${d.state}${d.preview !== null ? " pic" : ""}`}
          title={d.state === "failed" ? `${d.name}: ${d.error}` : `${d.name} · ${sizeText(d.size)}`}>
          {d.preview !== null
            ? <img class="att-thumb" src={d.preview} alt={d.name} />
            : <><Iconoir name="attachment" /><span class="att-name">{d.name}</span><span class="att-size">{sizeText(d.size)}</span></>}
          {d.state === "uploading" && <Spinner />}
          {d.state === "failed" && <span class="att-bad"><Iconoir name="warning" /><span class="sr">not uploaded: {d.error}</span></span>}
          <button class="x" title="Remove" aria-label={`Remove ${d.name}`} onClick={() => onRemove(d.id)}>×</button>
        </span>
      ))}
    </div>
  );
}

function Spinner() {
  return (
    <svg class="att-spin spin" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" role="img" aria-label="uploading">
      <path d="M8 2a6 6 0 1 1-6 6" />
    </svg>
  );
}

/** A prompt's files in the thread: an image as a thumbnail that opens it full size in a new tab, any other file as a chip that downloads it. */
export function AttachmentList({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div class="attachments">
      {attachments.map((a, i) => shownInline(a.type)
        ? (
          <a key={i} class="thumb" href={blobUrl(a)} target="_blank" rel="noopener noreferrer" title={`${a.name} · ${sizeText(a.size)}`}>
            <img src={blobUrl(a)} alt={a.name} loading="lazy" />
          </a>
        )
        : (
          <a key={i} class="att" href={blobUrl(a)} download={a.name} title={`Download ${a.name}`}>
            <Iconoir name="attachment" /><span class="att-name">{a.name}</span><span class="att-size">{sizeText(a.size)}</span>
          </a>
        ))}
    </div>
  );
}

/** The paperclip: picks files to attach. */
export function AttachButton({ onFiles, disabled = false }: { onFiles(files: File[]): void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button class="attach" type="button" disabled={disabled} title="Attach files (or paste or drop them)" aria-label="Attach files"
        onClick={() => input.current?.click()}>
        <Iconoir name="attachment" />
      </button>
      <input ref={input} type="file" multiple hidden onChange={(e) => {
        const files = Array.from(e.currentTarget.files ?? []);
        // Emptied, so picking the same file again still changes it.
        e.currentTarget.value = "";
        if (files.length > 0) onFiles(files);
      }} />
    </>
  );
}
