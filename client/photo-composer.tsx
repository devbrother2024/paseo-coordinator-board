import { copyText } from "@getpaseo/plugin/client/ui";
import { useRef, useState, type ReactNode } from "react";
import { Platform, Text, View } from "react-native";
import { MAX_WORK_IMAGES, WORK_IMAGE_MIME_TYPES } from "../shared/operations";
import { Button, type Theme } from "./controls";
import { useBoardLanguage } from "./language";
import { wrap } from "./route-editor";
import { photoShrinkSupported, shrinkInBrowser, shrinkSummary } from "./photo-shrink";
import { clipboardPhotos, isFileDrag, prepareWorkPhotos, type DraftPhoto, type PhotoError } from "./work-photos";

export function usePhotoDraft() {
  const [photos, setPhotos] = useState<DraftPhoto[]>([]);
  const latest = useRef<DraftPhoto[]>([]);
  const failed = useRef(new Map<number | undefined, PhotoError>());
  const [errors, setErrors] = useState(failed.current);
  const [inputScope, setInputScope] = useState<number>();
  const [reading, setReading] = useState(false);
  const readPending = useRef(false);
  const sequence = useRef(0);

  function update(next: DraftPhoto[]) {
    latest.current = next;
    setPhotos(next);
  }

  function setFailure(scope: number | undefined, error: PhotoError | null) {
    const next = new Map(failed.current);
    if (error) next.set(scope, error);
    else next.delete(scope);
    failed.current = next;
    setErrors(next);
  }

  // Event handlers may run before React paints the reading/error state.
  function blocksSubmit() {
    return readPending.current || failed.current.size > 0;
  }

  async function add(files: File[], questionIndex?: number) {
    if (readPending.current) return;
    setInputScope(questionIndex);
    readPending.current = true;
    setReading(true);
    try {
      const shrink = photoShrinkSupported(Platform.OS) ? shrinkInBrowser : undefined;
      const prepared = await prepareWorkPhotos(latest.current, files, shrink);
      if (typeof prepared === "string") {
        setFailure(questionIndex, prepared);
        return;
      }
      const batch: DraftPhoto[] = prepared.map(photo => ({ ...photo, id: ++sequence.current, questionIndex,
        preview: `data:${photo.image.mimeType};base64,${photo.image.data}` }));
      update([...latest.current, ...batch]);
      setFailure(questionIndex, null);
    } catch {
      setFailure(questionIndex, "read");
    } finally {
      readPending.current = false;
      setReading(false);
    }
  }

  function remove(id: number) {
    update(latest.current.filter(photo => photo.id !== id));
  }

  function clear() {
    update([]);
    failed.current = new Map();
    setErrors(failed.current);
  }
  return { photos, latest, errors, reading, inputScope, readPending, blocked: reading || errors.size > 0,
    blocksSubmit, add, remove, clear, dismissFailure: (scope?: number) => setFailure(scope, null) };
}

type Props = {
  children: ReactNode; theme: Theme; disabled: boolean; draft: ReturnType<typeof usePhotoDraft>;
  text?: string; openSession?: () => void; questionIndex?: number; showHint?: boolean;
  // Without controls, the attach button is folded away while paste and drop into the field still attach photos.
  controls?: boolean;
};

export function PhotoComposer({ children, theme, disabled, draft, text = "", openSession, questionIndex, showHint, controls = true }: Props) {
  const { t } = useBoardLanguage();
  const fileInput = useRef<HTMLInputElement>(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const [dragging, setDragging] = useState(false);
  const supportsPicker = Platform.OS === "web" && typeof document !== "undefined" && typeof FileReader !== "undefined";
  const colors = theme.colors;
  if (!supportsPicker) {
    const open = async () => {
      setCopyFailed(false);
      if (text.trim()) {
        try { await copyText(text); }
        catch { setCopyFailed(true); return; }
      }
      openSession?.();
    };
    return <View style={{ gap: 6 }}>
      {children}
      {openSession && <Button theme={theme} disabled={disabled} onPress={() => void open()}
        label={text.trim() ? t("요청 글 복사 후 사진을 첨부할 세션 열기", "Copy request and open session to attach photos")
          : t("세션에서 사진 첨부하기", "Attach photos in the session")} />}
      {openSession && <Text style={{ color: colors.foregroundMuted }}>{text.trim()
        ? t("세션 입력창에 복사한 글을 붙여넣고 사진을 첨부해 보내세요.", "Paste the copied request into the session composer, attach photos, then send.")
        : t("사진은 코디네이터 세션의 입력창에서 선택해 보낼 수 있습니다.", "Select and send photos in the coordinator session composer.")}</Text>}
      {copyFailed && <Text accessibilityLiveRegion="polite" style={{ color: colors.statusDanger }}>{t("글을 복사할 수 없습니다. 입력한 글을 직접 복사한 뒤 코디네이터 세션을 여세요.", "Could not copy the draft. Copy it manually, then open the coordinator session.")}</Text>}
    </View>;
  }

  const locked = disabled || draft.reading;
  const photos = draft.photos.filter(photo => photo.questionIndex === questionIndex);
  const attachLabel = t("첨부 파일 추가", "Add attachment");
  const atLimit = draft.photos.length >= MAX_WORK_IMAGES;
  const readingHere = draft.reading && draft.inputScope === questionIndex;
  const error = draft.errors.get(questionIndex);
  const errorText = {
    format: t("JPEG, PNG 또는 WebP 사진을 선택해 주세요.", "Choose JPEG, PNG or WebP photos."),
    count: t("사진은 요청당 최대 4장까지 첨부할 수 있습니다.", "Attach up to 4 photos per request."),
    size: t("각 사진은 0바이트보다 크고 5MiB 이하여야 합니다.", "Each photo must be nonempty and at most 5 MiB."),
    total: t("첨부한 사진의 합계가 한도(12MiB)를 넘습니다. 다른 첨부를 빼 주세요.", "Attached photos exceed the 12 MiB total. Remove another attachment."),
    read: t("사진을 읽지 못했습니다. 파일을 다시 선택해 주세요.", "Could not read the photo. Select the file again."),
    shrink: t("사진을 한도(장당 5MiB, 합계 12MiB) 안으로 줄이지 못했습니다. 다른 사진을 선택해 주세요.",
      "Could not shrink the photo to fit the limits (5 MiB each, 12 MiB combined). Choose a different photo."),
    source: t("사진이 너무 커서 줄일 수 없습니다(최대 50MiB, 5000만 화소). 더 작은 사진을 선택해 주세요.",
      "The photo is too large to shrink (up to 50 MiB and 50 megapixels). Choose a smaller photo."),
  };
  return <div style={{ display: "flex", flexDirection: "column", gap: 6, borderRadius: 6, outline: dragging ? `2px dashed ${colors.accent}` : undefined }}
    onDragOver={event => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = locked ? "none" : "copy";
      setDragging(!locked);
    }}
    onDragLeave={event => {
      if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDragging(false);
    }}
    onDrop={event => {
      if (!isFileDrag(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      setDragging(false);
      if (!locked && !draft.readPending.current) void draft.add(clipboardPhotos(event.dataTransfer), questionIndex);
    }}
    onPaste={event => {
      if (locked || draft.readPending.current) return;
      const files = clipboardPhotos(event.clipboardData);
      if (!files.length && !isFileDrag(event.clipboardData)) return;
      if (!Array.from(event.clipboardData.types ?? []).includes("text/plain")) event.preventDefault();
      event.stopPropagation();
      void draft.add(files, questionIndex);
    }}>
    {children}
    <input ref={fileInput} type="file" multiple hidden accept={WORK_IMAGE_MIME_TYPES.join(",")} disabled={locked}
      onChange={event => {
        if (locked || draft.readPending.current) return;
        const files = Array.from(event.currentTarget.files ?? []);
        event.currentTarget.value = "";
        if (files.length) void draft.add(files, questionIndex);
      }} />
    {(controls || readingHere || dragging) && <View style={{ ...wrap, alignItems: "center" }}>
      {controls && <button type="button" aria-label={attachLabel} title={attachLabel} disabled={locked || atLimit}
        style={{ display: "inline-grid", placeItems: "center", width: 34, height: 34, borderRadius: 7, color: colors.foreground,
          background: colors.surface0, border: `1px solid ${colors.border}`, opacity: locked || atLimit ? 0.6 : 1, cursor: locked || atLimit ? "default" : "pointer" }}
        onClick={() => fileInput.current?.click()}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
          <path d="m20.5 11.3-8.6 8.6a5.5 5.5 0 0 1-7.8-7.8L14 2.2a3.8 3.8 0 0 1 5.4 5.4l-10 10a2.1 2.1 0 0 1-3-3l9.1-9.1" />
        </svg>
      </button>}
      {(readingHere || photos.length > 0 || dragging || showHint) && <Text accessibilityLiveRegion="polite" style={{ color: colors.foregroundMuted }}>{readingHere ? t("사진 준비 중…", "Preparing photos…")
        : dragging ? t("여기에 사진 놓기", "Drop photos here")
        : photos.length ? t(`사진 ${photos.length}장`, `${photos.length} photo${photos.length === 1 ? "" : "s"}`)
        : t("입력창에 사진을 끌어 놓거나 붙여넣으세요.", "Drop or paste photos into the input.")}</Text>}
    </View>}
    {photos.map(photo => {
      const name = photo.name || t(`사진 ${photo.id}`, `Photo ${photo.id}`);
      const ordinal = draft.photos.indexOf(photo) + 1;
      const distinguish = draft.photos.some(other => other.id !== photo.id && other.name === photo.name);
      const displayName = distinguish ? `${ordinal}. ${name}` : name;
      const summary = photo.shrunk && shrinkSummary(photo.shrunk);
      return <View key={photo.id} style={{ ...wrap, alignItems: "center" }}>
        <img src={photo.preview} alt={t(`첨부 사진 ${ordinal} · ${name}`, `Attached photo ${ordinal} · ${name}`)}
          width={56} height={56} decoding="async" style={{ objectFit: "contain", borderRadius: 4, backgroundColor: colors.surface0 }} />
        <View style={{ flexShrink: 1 }}>
          <Text selectable style={{ color: colors.foreground }}>{displayName}</Text>
          {summary && <Text selectable style={{ color: colors.foregroundMuted, fontSize: 12 }}>
            {t(`자동으로 줄임: ${summary.bytes}, ${summary.pixels}`, `Shrunk automatically: ${summary.bytes}, ${summary.pixels}`)}
            {photo.shrunk?.firstFrameOnly ? t(", 첫 프레임만 보냄", ", first frame only") : ""}</Text>}
        </View>
        <Button theme={theme} label={t("제거", "Remove")} accessibilityLabel={t(`사진 제거 · ${displayName}`, `Remove photo · ${displayName}`)}
          disabled={locked} onPress={() => draft.remove(photo.id)} />
      </View>;
    })}
    {error && <View style={{ gap: 4 }}>
      <Text accessibilityLiveRegion="polite" style={{ color: colors.statusDanger }}>{errorText[error]}</Text>
      <View style={wrap}>
        <Button theme={theme} label={t("파일 다시 선택", "Choose files again")} disabled={locked || atLimit}
          onPress={() => fileInput.current?.click()} />
        <Button theme={theme} label={t("실패한 첨부 취소", "Discard failed attachment")} disabled={locked}
          onPress={() => draft.dismissFailure(questionIndex)} />
      </View>
    </View>}
  </div>;
}
