import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  SignalingClient,
  defaultSignalingUrl,
  type ConnectionState,
} from "./signaling/SignalingClient";
import { WebRtcRoom, type WebRtcRoomEvents } from "./webrtc/WebRtcRoom";
import {
  SfuRoom,
  fetchMediaConfig,
  fetchMediaToken,
  resolveLivekitUrl,
  type MediaConfig,
  type MediaRoom,
} from "./webrtc/SfuRoom";
import { VideoTile } from "./components/VideoTile";
import { ChatPanel } from "./components/ChatPanel";
import { CollabPanel } from "./components/CollabPanel";
import { MemberList, type Member } from "./components/MemberList";
import { RecordingsPanel, type Recording } from "./components/RecordingsPanel";
import { FilesPanel } from "./components/FilesPanel";
import {
  SearchPanel,
  SEARCH_PAGE_SIZE,
  type SearchHit,
} from "./components/SearchPanel";
import { AgendaPanel } from "./components/AgendaPanel";
import { MeetingsPanel } from "./components/MeetingsPanel";
import { RoomAnnouncer } from "./components/RoomAnnouncer";
import { SidebarTabs } from "./components/SidebarTabs";
import { CaptionOverlay } from "./components/CaptionOverlay";
import {
  TranscriptPanel,
  type MeetingSummary,
} from "./components/TranscriptPanel";
import { useSpeechCaptions } from "./captions/useSpeechCaptions";
import {
  applyCaption,
  applyTranslation,
  prune,
  visible,
  type SubtitleLine,
} from "./captions/subtitle";
import { WorkspaceDivider } from "./components/WorkspaceDivider";
import { ReactionBar } from "./components/ReactionBar";
import { ThemeToggle } from "./components/ThemeToggle";
import {
  FloatingReactions,
  type FloatingReaction,
} from "./components/FloatingReactions";
import type {
  AgendaDue,
  Attachment,
  CalendarEvent,
  CaptionConfig,
  CaptionPayload,
  CaptionTranslatedPayload,
  MediaState,
  PeerInfo,
  Meeting,
  RoomStateInfo,
  StoredMessage,
  Todo,
  TranscriptLine,
} from "./signaling/types";
import type { PeerQuality } from "./webrtc/quality";
import type { AgendaItem, Triage } from "./agenda/item";
import { parseCapture } from "./agenda/capture";
import {
  SIDEBAR_DEFAULT,
  SIDEBAR_KEY,
  TILE_DEFAULT,
  TILE_KEY,
  clampSidebar,
  clampTile,
  readNumber,
  stepTile,
  writeNumber,
  TILE_STEPS,
} from "./layout/workspace";
import { useAuth } from "./auth/AuthGate";
import { useTheme } from "./theme/useTheme";
import "./App.css";

type Status = "idle" | "connecting" | "in-room" | "error";

// The mesh topology degrades as peers multiply; warn before the hard cap (backend: 8).
const ROOM_WARN_THRESHOLD = 6;

/** Chat message as stored locally; the sender's display name is resolved at render time. */
interface ChatEntry {
  id: string;
  fromId: string;
  text: string;
  mine: boolean;
  /** For replayed history: the sender's name as recorded, since they may have left. */
  name?: string;
}

/** The side panels, one of which is open at a time. */
type SidebarTab =
  | "members"
  | "agenda"
  | "transcript"
  | "meetings"
  | "recordings"
  | "search"
  | "files"
  | "chat";

export default function App() {
  const { token, displayName: authName } = useAuth();
  const {
    theme,
    preference: themePreference,
    setPreference: setThemePreference,
  } = useTheme();
  const [room, setRoom] = useState("war-room");
  // With OIDC active the identity provider supplies the name; it stays editable.
  const [name, setName] = useState(authName ?? "");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStreams, setRemoteStreams] = useState<Map<string, MediaStream>>(
    new Map(),
  );
  const [names, setNames] = useState<Map<string, string>>(new Map());
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [screenSharing, setScreenSharing] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [peerStates, setPeerStates] = useState<Map<string, MediaState>>(
    new Map(),
  );
  const [handRaised, setHandRaised] = useState(false);
  const [raisedHands, setRaisedHands] = useState<Set<string>>(new Set());
  const [reactions, setReactions] = useState<FloatingReaction[]>([]);
  const [mediaMode, setMediaMode] = useState<"mesh" | "sfu">("mesh");
  /**
   * The same value, readable from a closure that was built earlier.
   *
   * The `room-state` handler is registered once per join and would otherwise
   * compare against whatever `mediaMode` was at that moment — which is "mesh",
   * for ever, so the room would try to switch to the SFU on every room-state
   * message it received after the first.
   */
  const mediaModeRef = useRef<"mesh" | "sfu">("mesh");
  const [recordingId, setRecordingId] = useState<string | null>(null);
  const [roomState, setRoomState] = useState<RoomStateInfo>({
    host: "",
    locked: false,
  });
  const [connection, setConnection] = useState<ConnectionState>("closed");
  const [peerQuality, setPeerQuality] = useState<Map<string, PeerQuality>>(
    new Map(),
  );
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [files, setFiles] = useState<Attachment[]>([]);
  // The panel is offered only where an upload could actually succeed: the list
  // endpoint 404s without an object store, so its response is the answer.
  const [fileSharingAvailable, setFileSharingAvailable] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [calendar, setCalendar] = useState<CalendarEvent[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  // What the server has told the room is due. Kept until dismissed: a nudge
  // that vanishes on its own is one the person who looked away never saw.
  const [due, setDue] = useState<AgendaDue[]>([]);
  // The shared list and calendar need a database; without one the endpoints
  // 404 and the panels are not offered rather than failing on every action.
  const [agendaAvailable, setAgendaAvailable] = useState(false);
  // --- Captions. Three independent facts, so three pieces of state rather than
  // one "captions on" flag: whether this browser is *producing* them, whether
  // the deployment *keeps* them, and whether it *translates* them.
  const [captionConfig, setCaptionConfig] = useState<CaptionConfig | null>(
    null,
  );
  const [captionsOn, setCaptionsOn] = useState(false);
  // What this participant is speaking — nothing else. It used to also decide
  // which language the subtitles put on top, which made one control mean two
  // unrelated things; the subtitles now always show both, in a fixed order.
  const [captionLang, setCaptionLang] = useState<"zh" | "en">("zh");
  // The live track. Ephemeral by construction: it is never read back from the
  // server and never survives a reload, exactly like awareness on the CRDT plane.
  const [subtitles, setSubtitles] = useState<SubtitleLine[]>([]);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [summary, setSummary] = useState<MeetingSummary | null>(null);
  // Which side panel is showing. Chat is the default because it is the one
  // people keep open.
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>("chat");
  // How the workspace is split, and how big the tiles are. Both are this
  // browser's preference rather than the room's, so they live in localStorage
  // and never touch the signaling plane.
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clampSidebar(readNumber(localStorage, SIDEBAR_KEY, SIDEBAR_DEFAULT)),
  );
  const [tileSize, setTileSize] = useState(() =>
    clampTile(readNumber(localStorage, TILE_KEY, TILE_DEFAULT)),
  );
  const workspaceRef = useRef<HTMLElement>(null);

  const resizeSidebar = useCallback((next: number) => {
    setSidebarWidth(next);
    writeNumber(localStorage, SIDEBAR_KEY, next);
  }, []);

  const resizeTiles = useCallback((by: 1 | -1) => {
    setTileSize((current) => {
      const next = stepTile(current, by);
      writeNumber(localStorage, TILE_KEY, next);
      return next;
    });
  }, []);

  const applyMediaMode = useCallback((mode: "mesh" | "sfu") => {
    mediaModeRef.current = mode;
    setMediaMode(mode);
  }, []);

  const clientRef = useRef<SignalingClient | null>(null);
  const roomRef = useRef<MediaRoom | null>(null);
  /** Kept so a transport switch mid-meeting can rebuild without refetching. */
  const mediaConfigRef = useRef<MediaConfig | null>(null);
  /** What the media rooms report into. Rebuilt with them on a transport switch. */
  const mediaEventsRef = useRef<WebRtcRoomEvents | null>(null);
  const selfIdRef = useRef<string>(crypto.randomUUID());
  const cameraStreamRef = useRef<MediaStream | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  // Mirror the flags so listeners registered once can read the latest values.
  const mediaStateRef = useRef<MediaState>({ audio: true, video: true });
  const handRaisedRef = useRef(false);
  const recordingIdRef = useRef<string | null>(null);
  // Read at reconnect time rather than captured at join time: a silent renew may
  // have replaced the token since, and a stale one is refused at the handshake.
  const tokenRef = useRef(token);
  tokenRef.current = token;

  /**
   * Bearer header for API calls, read from the ref rather than the captured
   * value: a silent renew may have replaced the token since the callback was
   * created. Empty without OIDC, which is what the permit-all default expects.
   */
  const authHeaders = useCallback(
    (): Record<string, string> =>
      tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : {},
    [],
  );
  // The room/name in effect for the session, so a reconnect can re-join without
  // depending on the inputs, which the user may have edited meanwhile.
  const joinedAsRef = useRef<{ room: string; displayName: string } | null>(
    null,
  );

  /** Resolves a peer id to its display name, falling back to a short id. */
  const nameOf = (peerId: string) => names.get(peerId) ?? peerId.slice(0, 8);

  /** Adds a floating emoji that removes itself after the animation. */
  const showReaction = useCallback((emoji: string) => {
    const id = crypto.randomUUID();
    const left = 10 + Math.floor(parseInt(id.slice(0, 8), 16) % 80);
    setReactions((prev) => [...prev, { id, emoji, left }]);
    setTimeout(
      () => setReactions((prev) => prev.filter((r) => r.id !== id)),
      3000,
    );
  }, []);

  /** Everyone currently in the room, self first, for the member list. */
  const members: Member[] = [
    {
      id: selfIdRef.current,
      name: name.trim() || "你",
      isSelf: true,
      audioOff: !audioEnabled,
      videoOff: !videoEnabled,
      handRaised,
    },
    ...[...names].map(([id, memberName]) => ({
      id,
      name: memberName,
      isSelf: false,
      audioOff: peerStates.get(id)?.audio === false,
      videoOff: peerStates.get(id)?.video === false,
      handRaised: raisedHands.has(id),
      quality: peerQuality.get(id)?.level,
      degraded: peerQuality.get(id)?.degraded,
    })),
  ];

  /** Tears down the session and resets all room state (does not notify the server). */
  const teardown = useCallback(() => {
    // Leaving with a recording running: stop it best-effort.
    if (recordingIdRef.current) {
      void fetch(
        `/api/media/recordings/stop?egressId=${encodeURIComponent(recordingIdRef.current)}`,
        {
          method: "POST",
        },
      );
      recordingIdRef.current = null;
      setRecordingId(null);
    }
    clientRef.current?.close();
    cameraStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    roomRef.current = null;
    clientRef.current = null;
    cameraStreamRef.current = null;
    screenStreamRef.current = null;
    setLocalStream(null);
    setRemoteStreams(new Map());
    setNames(new Map());
    setPeerStates(new Map());
    setPeerQuality(new Map());
    setRecordings([]);
    setFiles([]);
    setFileSharingAvailable(false);
    setTodos([]);
    setCalendar([]);
    setAgendaAvailable(false);
    // Captions stop with the room. Leaving with the microphone still being
    // transcribed would be the worst kind of surprise this feature could hold.
    setCaptionsOn(false);
    setSubtitles([]);
    setTranscript([]);
    setSummary(null);
    setCaptionConfig(null);
    setMessages([]);
    setScreenSharing(false);
    setAudioEnabled(true);
    setVideoEnabled(true);
    setHandRaised(false);
    setRaisedHands(new Set());
    setReactions([]);
    setRoomState({ host: "", locked: false });
    applyMediaMode("mesh");
    setConnection("closed");
    joinedAsRef.current = null;
    mediaStateRef.current = { audio: true, video: true };
    handRaisedRef.current = false;
    setStatus("idle");
  }, []);

  /**
   * Recovers the room after the signaling socket came back. The server dropped
   * our membership when the old socket died — everyone else was told we left —
   * so this re-announces us and replays the state the others can no longer see.
   */
  const rejoin = useCallback((client: SignalingClient) => {
    const joined = joinedAsRef.current;
    if (!joined) return;
    // Media first: stale peer connections must be gone before the `peers` reply
    // arrives and starts building new ones.
    roomRef.current?.handleReconnect();
    setPeerStates(new Map());
    setRaisedHands(new Set());
    setPeerQuality(new Map());

    client.send({
      type: "join",
      room: joined.room,
      from: selfIdRef.current,
      payload: joined.displayName,
    });
    // Flags live only in other clients' memory, so they have to be re-sent.
    client.send({
      type: "state",
      room: joined.room,
      from: selfIdRef.current,
      payload: mediaStateRef.current,
    });
    if (handRaisedRef.current) {
      client.send({
        type: "hand",
        room: joined.room,
        from: selfIdRef.current,
        payload: true,
      });
    }
  }, []);

  /**
   * Loads this room's finished recordings. The endpoint 404s unless the
   * recording overlay and a database are both present, which is the ordinary
   * case — an empty list simply hides the panel.
   */
  const loadRecordings = useCallback(async (roomName: string) => {
    try {
      const res = await fetch(
        `/api/recordings/${encodeURIComponent(roomName)}`,
        {
          headers: authHeaders(),
        },
      );
      setRecordings(res.ok ? ((await res.json()) as Recording[]) : []);
    } catch {
      setRecordings([]);
    }
  }, []);

  /** Playback URLs expire, so one is minted per press rather than per listing. */
  const recordingUrl = useCallback(async (id: number) => {
    const res = await fetch(
      `/api/recordings/${encodeURIComponent(joinedAsRef.current?.room ?? "")}/${id}/url`,
      { headers: authHeaders() },
    );
    if (!res.ok) throw new Error(`無法取得播放連結(HTTP ${res.status})`);
    return ((await res.json()) as { url: string }).url;
  }, []);

  /**
   * Loads the files shared into this room. 404s without an object store, which
   * is the ordinary case — an empty list simply hides the panel.
   */
  const loadFiles = useCallback(async (roomName: string) => {
    try {
      const res = await fetch(
        `/api/attachments/${encodeURIComponent(roomName)}`,
        {
          headers: authHeaders(),
        },
      );
      setFileSharingAvailable(res.ok);
      setFiles(res.ok ? ((await res.json()) as Attachment[]) : []);
    } catch {
      setFileSharingAvailable(false);
      setFiles([]);
    }
  }, []);

  /**
   * Uploads a file straight to the object store: the server signs a URL, the
   * bytes go there directly, and only then is the upload confirmed. XHR rather
   * than fetch because it is the only way to get real progress events.
   */
  const uploadFile = useCallback(
    async (file: File, onProgress: (f: number) => void) => {
      const roomName = joinedAsRef.current?.room ?? "";
      const signRes = await fetch(
        `/api/attachments/${encodeURIComponent(roomName)}/upload-url`,
        {
          method: "POST",
          headers: { ...authHeaders(), "content-type": "application/json" },
          body: JSON.stringify({
            filename: file.name,
            contentType: file.type || "application/octet-stream",
            sizeBytes: file.size,
          }),
        },
      );
      if (!signRes.ok) {
        throw new Error(
          signRes.status === 413
            ? "檔案太大"
            : `無法上傳(HTTP ${signRes.status})`,
        );
      }
      const { uploadUrl, objectKey } = (await signRes.json()) as {
        uploadUrl: string;
        objectKey: string;
      };

      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.open("PUT", uploadUrl);
        // The signature covers the method, path and host — not the content type,
        // so setting one here would not invalidate it, but the store records it
        // and we would rather it match what we tell the server afterwards.
        xhr.setRequestHeader(
          "content-type",
          file.type || "application/octet-stream",
        );
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) onProgress(e.loaded / e.total);
        };
        xhr.onload = () =>
          xhr.status >= 200 && xhr.status < 300
            ? resolve()
            : reject(new Error(`上傳失敗(HTTP ${xhr.status})`));
        xhr.onerror = () => reject(new Error("上傳失敗"));
        xhr.send(file);
      });

      const confirmRes = await fetch(
        `/api/attachments/${encodeURIComponent(roomName)}`,
        {
          method: "POST",
          headers: { ...authHeaders(), "content-type": "application/json" },
          body: JSON.stringify({
            objectKey,
            filename: file.name,
            contentType: file.type || "application/octet-stream",
          }),
        },
      );
      if (!confirmRes.ok)
        throw new Error(`無法記錄檔案(HTTP ${confirmRes.status})`);
      await loadFiles(roomName);
    },
    [loadFiles],
  );

  /** Download URLs expire, so one is minted per press rather than per listing. */
  const fileUrl = useCallback(async (id: number) => {
    const res = await fetch(
      `/api/attachments/${encodeURIComponent(joinedAsRef.current?.room ?? "")}/${id}/url`,
      { headers: authHeaders() },
    );
    if (!res.ok) throw new Error(`無法取得下載連結(HTTP ${res.status})`);
    return ((await res.json()) as { url: string }).url;
  }, []);

  const deleteFile = useCallback(
    async (id: number) => {
      const roomName = joinedAsRef.current?.room ?? "";
      const res = await fetch(
        `/api/attachments/${encodeURIComponent(roomName)}/${id}`,
        {
          method: "DELETE",
          headers: authHeaders(),
        },
      );
      if (!res.ok) {
        throw new Error(
          res.status === 403
            ? "只有主持人可以刪除"
            : `刪除失敗(HTTP ${res.status})`,
        );
      }
      await loadFiles(roomName);
    },
    [loadFiles],
  );

  /**
   * Loads the room's agenda: both feeds, merged into one board by the panel.
   *
   * The calendar is read from a week back rather than from now. Its endpoint
   * defaults to "what is coming", which is right for a calendar and wrong for a
   * board — an entry whose time has passed belongs in 完成, and fetching only
   * the future would make it vanish the moment it mattered least. A week is the
   * window a room in session still refers back to; older than that is history,
   * and history is not what this panel is for.
   */
  const loadAgenda = useCallback(
    async (roomName: string) => {
      const room = encodeURIComponent(roomName);
      const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
      try {
        const [todoRes, calendarRes] = await Promise.all([
          fetch(`/api/todos/${room}`, { headers: authHeaders() }),
          fetch(`/api/calendar/${room}?from=${encodeURIComponent(from)}`, {
            headers: authHeaders(),
          }),
        ]);
        setAgendaAvailable(todoRes.ok && calendarRes.ok);
        setTodos(todoRes.ok ? ((await todoRes.json()) as Todo[]) : []);
        setCalendar(
          calendarRes.ok ? ((await calendarRes.json()) as CalendarEvent[]) : [],
        );
      } catch {
        setAgendaAvailable(false);
        setTodos([]);
        setCalendar([]);
      }
    },
    [authHeaders],
  );

  /**
   * What this deployment can do with speech, and what it has already kept.
   *
   * <p>Asked once on join rather than assumed. Recording needs a database and
   * translation needs a language model, and a browser that guessed would either
   * hide a working feature or promise one that is not there.
   */
  const loadCaptions = useCallback(
    async (roomName: string) => {
      const room = encodeURIComponent(roomName);
      try {
        const configRes = await fetch("/api/captions/config", {
          headers: authHeaders(),
        });
        const config = configRes.ok
          ? ((await configRes.json()) as CaptionConfig)
          : null;
        setCaptionConfig(config);
        if (!config?.recording) {
          setTranscript([]);
          return;
        }
        const res = await fetch(`/api/captions/${room}`, {
          headers: authHeaders(),
        });
        setTranscript(res.ok ? ((await res.json()) as TranscriptLine[]) : []);
      } catch {
        setCaptionConfig(null);
        setTranscript([]);
      }
    },
    [authHeaders],
  );

  /**
   * Gets this meeting's summary, making one if it does not exist yet.
   *
   * <p>POST rather than GET even when only reading: the server decides whether a
   * model call is needed, and two people opening the panel must not buy two
   * summaries of the same hour. `regenerate` is the explicit override.
   */
  const summarizeMeeting = useCallback(
    async (meetingId: number, regenerate: boolean) => {
      const res = await fetch(
        `/api/meetings/${encodeURIComponent(room)}/${meetingId}/summary` +
          (regenerate ? "?regenerate=true" : ""),
        { method: "POST", headers: authHeaders() },
      );
      if (!res.ok) {
        // The server's reason, not a generic failure: "not enough transcript to
        // summarise" is something the reader can act on, and hiding it behind
        // "failed" would send them looking for a bug that is not there.
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } | null;
        throw new Error(body?.message ?? `產生摘要失敗(HTTP ${res.status})`);
      }
      setSummary((await res.json()) as MeetingSummary);
    },
    [room, authHeaders],
  );

  /** The room's own history. Absent without the postgres profile, like the agenda. */
  const loadMeetings = useCallback(
    async (roomName: string) => {
      try {
        const res = await fetch(
          `/api/meetings/${encodeURIComponent(roomName)}`,
          {
            headers: authHeaders(),
          },
        );
        setMeetings(res.ok ? ((await res.json()) as Meeting[]) : []);
      } catch {
        setMeetings([]);
      }
    },
    [authHeaders],
  );

  /**
   * Downloads a meeting's record.
   *
   * <p>Fetched rather than linked because the request needs the auth header,
   * which an `<a href>` cannot carry. The blob URL is revoked straight away —
   * it pins the whole document in memory until it is.
   */
  const exportMeeting = useCallback(
    async (meeting: Meeting) => {
      const roomName = joinedAsRef.current?.room ?? "";
      const res = await fetch(
        `/api/meetings/${encodeURIComponent(roomName)}/${meeting.id}/export`,
        { headers: authHeaders() },
      );
      if (!res.ok) throw new Error(`匯出失敗(HTTP ${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${roomName.replace(/[^A-Za-z0-9._-]/g, "-")}-${meeting.id}.md`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    },
    [authHeaders],
  );

  /**
   * Sends an agenda change and reloads. The list is refetched rather than
   * patched locally because the server owns the ordering — open items first,
   * then soonest-due — and guessing it here is how two people end up looking at
   * different "first" items.
   */
  const agendaWrite = useCallback(
    async (path: string, init: RequestInit) => {
      const roomName = joinedAsRef.current?.room ?? "";
      const res = await fetch(path, {
        ...init,
        headers: { ...authHeaders(), "content-type": "application/json" },
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          detail?: string;
        } | null;
        throw new Error(
          res.status === 403
            ? "只有主持人可以刪除"
            : (detail?.detail ?? `操作失敗(HTTP ${res.status})`),
        );
      }
      await loadAgenda(roomName);
    },
    [authHeaders, loadAgenda],
  );

  const roomPath = () => encodeURIComponent(joinedAsRef.current?.room ?? "");

  /**
   * Files a captured line as whatever it described.
   *
   * The panel has one input because the room has one agenda, but the database
   * still keeps appointments and tasks in two tables, and *something* has to
   * choose. The rule is the one the user can see: a line that named a span
   * (`14:00-15:00`) described a thing that occupies time, so it becomes a
   * calendar entry; everything else becomes a task. The preview says which,
   * before it is sent, so the choice is never made behind anyone's back.
   */
  const addAgendaItem = useCallback(
    (captured: {
      text: string;
      assignee?: string;
      dueAt?: string;
      endAt?: string;
    }) =>
      captured.endAt
        ? agendaWrite(`/api/calendar/${roomPath()}`, {
            method: "POST",
            body: JSON.stringify({
              title: captured.text,
              startsAt: captured.dueAt,
              endsAt: captured.endAt,
              // An appointment can belong to somebody. Omitting this is what
              // used to make `@bob 14:00-15:00` show @bob in the preview and
              // then lose it: the span routed the line here, and here had
              // nowhere to put a person.
              assignee: captured.assignee ?? "",
            }),
          })
        : agendaWrite(`/api/todos/${roomPath()}`, {
            method: "POST",
            // Already an instant: the capture line parsed it against the local
            // clock, so no further conversion belongs here.
            body: JSON.stringify({
              text: captured.text,
              assignee: captured.assignee ?? "",
              dueAt: captured.dueAt ?? "",
            }),
          }),
    [agendaWrite],
  );

  /**
   * Moves an item between sections.
   *
   * One request for both tables, because triage is one idea. The server turns
   * `DONE` into a completion with a time and an author rather than storing the
   * word — see `Triage` on the backend.
   */
  const setAgendaTriage = useCallback(
    (item: AgendaItem, triage: Triage | "auto") =>
      agendaWrite(
        `/api/${item.kind === "todo" ? "todos" : "calendar"}/${roomPath()}/${item.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({ triage: triage.toUpperCase() }),
        },
      ),
    [agendaWrite],
  );

  const deleteAgendaItem = useCallback(
    (item: AgendaItem) =>
      agendaWrite(
        `/api/${item.kind === "todo" ? "todos" : "calendar"}/${roomPath()}/${item.id}`,
        { method: "DELETE" },
      ),
    [agendaWrite],
  );

  /**
   * Runs a chat search. The results come from the indexer's read model, so the
   * endpoint is absent unless the events overlay is running — which is reported
   * as such rather than as an empty result, since "nothing matched" and "nothing
   * is indexed" are very different answers.
   */
  const searchMessages = useCallback(
    async (
      query: string,
      thisRoomOnly: boolean,
      offset: number,
    ): Promise<SearchHit[]> => {
      const params = new URLSearchParams({
        q: query,
        limit: String(SEARCH_PAGE_SIZE),
        offset: String(offset),
      });
      if (thisRoomOnly) params.set("room", joinedAsRef.current?.room ?? "");
      const res = await fetch(`/api/search/messages?${params}`, {
        headers: authHeaders(),
      });
      if (res.status === 404) throw new Error("這個部署沒有啟用訊息搜尋");
      if (!res.ok) throw new Error(`搜尋失敗(HTTP ${res.status})`);
      return (await res.json()) as SearchHit[];
    },
    [authHeaders],
  );

  /**
   * Deletes a recording and its file. The list is refetched rather than filtered
   * locally, so what is shown afterwards is what the server actually holds.
   */
  const deleteRecording = useCallback(
    async (id: number) => {
      const room = joinedAsRef.current?.room ?? "";
      const res = await fetch(
        `/api/recordings/${encodeURIComponent(room)}/${id}`,
        {
          method: "DELETE",
          headers: authHeaders(),
        },
      );
      if (!res.ok) throw new Error(`刪除失敗(HTTP ${res.status})`);
      await loadRecordings(room);
    },
    [loadRecordings],
  );

  const join = useCallback(async () => {
    setStatus("connecting");
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
      });
      cameraStreamRef.current = stream;
      setLocalStream(stream);

      const client = new SignalingClient(
        () => defaultSignalingUrl(tokenRef.current),
        {
          onStateChange: setConnection,
          onReconnected: () => rejoin(client),
        },
      );
      await client.connect();
      clientRef.current = client;

      // `peers` is the room's full membership, and it arrives again after every
      // reconnect — so it replaces the map rather than merging into it, or
      // members who left while we were away would linger forever.
      client.on("peers", (msg) =>
        setNames(
          new Map(
            ((msg.payload as PeerInfo[]) ?? []).map((p) => [p.id, p.name]),
          ),
        ),
      );
      client.on("peer-joined", (msg) => {
        if (!msg.from) return;
        setNames((prev) => new Map(prev).set(msg.from!, String(msg.payload)));
        // Re-announce our current media state and raised-hand status to the newcomer.
        client.send({
          type: "state",
          room,
          from: selfIdRef.current,
          payload: mediaStateRef.current,
        });
        if (handRaisedRef.current) {
          client.send({
            type: "hand",
            room,
            from: selfIdRef.current,
            payload: true,
          });
        }
      });
      client.on("peer-left", (msg) => {
        if (!msg.from) return;
        setNames((prev) => {
          const next = new Map(prev);
          next.delete(msg.from!);
          return next;
        });
        setPeerStates((prev) => {
          const next = new Map(prev);
          next.delete(msg.from!);
          return next;
        });
        setRaisedHands((prev) => {
          const next = new Set(prev);
          next.delete(msg.from!);
          return next;
        });
        setPeerQuality((prev) => {
          const next = new Map(prev);
          next.delete(msg.from!);
          return next;
        });
      });
      client.on("state", (msg) => {
        if (msg.from)
          setPeerStates((prev) =>
            new Map(prev).set(msg.from!, msg.payload as MediaState),
          );
      });
      client.on("room-full", (msg) => {
        teardown();
        setError(`房間已滿(上限 ${msg.payload} 人),請換一個房間或稍後再試`);
      });
      // Room meta: who hosts, whether newcomers are locked out, and which
      // transport the room is on. The last one can change under us — a room
      // that grows past the mesh limit is moved to the SFU — so this is also
      // where a live transport switch begins.
      client.on("room-state", (msg) => {
        const state = msg.payload as RoomStateInfo;
        setRoomState(state);
        if (state.mediaMode && state.mediaMode !== mediaModeRef.current) {
          void switchTransport(state.mediaMode);
        }
      });
      // Someone shared a file. The event carries it, but the list is refetched
      // so what is shown is the server's ordering, not an append guess.
      client.on("attachment", () => void loadFiles(room));
      // Someone changed the shared list or calendar; refetch the affected one.
      client.on("agenda", (msg) => {
        const kind = (msg.payload as { kind?: string } | undefined)?.kind;
        if (kind === "todo" || kind === "calendar") void loadAgenda(room);
      });
      // Something's time has arrived. Distinct from `agenda`, which only says
      // the list changed: refetching on this would show the same list again.
      client.on("agenda-due", (msg) => {
        const item = msg.payload as AgendaDue | undefined;
        if (!item?.id) return;
        setDue((current) =>
          current.some((d) => d.kind === item.kind && d.id === item.id)
            ? current
            : [...current, item],
        );
        void loadAgenda(room);
      });
      // A subtitle line. Interim ones only ever reach the screen; a final one
      // is also the transcript's newest row, so the panel gets it without a
      // refetch — the server has already told us everything the fetch would.
      client.on("caption", (msg) => {
        const payload = msg.payload as CaptionPayload | undefined;
        if (!payload?.text || !msg.from) return;
        setSubtitles((lines) =>
          applyCaption(
            lines,
            {
              id: payload.id,
              peerId: msg.from!,
              speaker: payload.speaker ?? nameOf(msg.from!),
              text: payload.text,
              lang: payload.lang,
              final: payload.final,
            },
            Date.now(),
          ),
        );
        if (payload.final && payload.id !== undefined) {
          const line: TranscriptLine = {
            id: payload.id,
            peerId: msg.from,
            speaker: payload.speaker ?? nameOf(msg.from),
            lang: payload.lang,
            text: payload.text,
            spokenAt: new Date(payload.spokenAt ?? Date.now()).toISOString(),
          };
          setTranscript((prev) =>
            prev.some((l) => l.id === line.id) ? prev : [...prev, line],
          );
        }
      });
      // The translation, catching up with a line already on screen.
      client.on("caption-translated", (msg) => {
        const update = msg.payload as CaptionTranslatedPayload | undefined;
        if (!update?.id) return;
        setSubtitles((lines) => applyTranslation(lines, update));
        setTranscript((prev) =>
          prev.map((line) =>
            line.id === update.id
              ? {
                  ...line,
                  translation: update.translation,
                  translationLang: update.translationLang,
                }
              : line,
          ),
        );
      });
      client.on("room-locked", () => {
        teardown();
        setError("房間已被主持人鎖定,目前不開放加入");
      });
      client.on("kicked", () => {
        teardown();
        setError("你已被主持人移出會議室");
      });
      client.on("reaction", (msg) => showReaction(String(msg.payload)));
      client.on("hand", (msg) => {
        if (!msg.from) return;
        setRaisedHands((prev) => {
          const next = new Set(prev);
          if (msg.payload) next.add(msg.from!);
          else next.delete(msg.from!);
          return next;
        });
      });

      // On join the server replays the room's recent chat history.
      client.on("history", (msg) => {
        const stored = (msg.payload as StoredMessage[]) ?? [];
        setMessages(
          stored.map((m) => ({
            id: crypto.randomUUID(),
            fromId: m.fromId,
            text: m.text,
            mine: m.fromId === selfIdRef.current,
            name: m.name,
          })),
        );
      });

      // Chat rides the same signaling socket, independent of the WebRTC mesh.
      client.on("chat", (msg) =>
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            fromId: msg.from ?? "unknown",
            text: String(msg.payload),
            mine: false,
          },
        ]),
      );

      const mediaEvents = {
        onRemoteStream: (peerId: string, remote: MediaStream) =>
          setRemoteStreams((prev) => new Map(prev).set(peerId, remote)),
        onPeerLeft: (peerId: string) =>
          setRemoteStreams((prev) => {
            const next = new Map(prev);
            next.delete(peerId);
            return next;
          }),
        onError: (reason: string) => setError(reason),
        onQuality: (peerId: string, quality: PeerQuality) =>
          setPeerQuality((prev) => new Map(prev).set(peerId, quality)),
      };
      mediaEventsRef.current = mediaEvents;

      const displayName =
        name.trim() || `訪客-${selfIdRef.current.slice(0, 4)}`;
      joinedAsRef.current = { room, displayName };

      // The backend decides the media transport for THIS room: the full mesh
      // while it is small, the SFU once it outgrows one. Signaling is identical
      // in both, which is what makes changing transport mid-meeting possible.
      const media = await fetchMediaConfig(token, room);
      mediaConfigRef.current = media;
      applyMediaMode(media.mode);
      const mediaRoom = await buildMediaRoom(
        media.mode,
        client,
        stream,
        mediaEvents,
        room,
        displayName,
      );
      roomRef.current = mediaRoom;
      mediaRoom.join(room, displayName);
      setStatus("in-room");
      void loadRecordings(room);
      void loadFiles(room);
      void loadAgenda(room);
      void loadMeetings(room);
      void loadCaptions(room);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }, [
    room,
    name,
    token,
    teardown,
    showReaction,
    rejoin,
    loadRecordings,
    loadFiles,
    loadAgenda,
    loadCaptions,
  ]);

  const leave = useCallback(() => {
    roomRef.current?.leave(room);
    teardown();
  }, [room, teardown]);

  /** Broadcasts our latest media on/off flags to the room. */
  const broadcastState = useCallback(
    (next: MediaState) => {
      mediaStateRef.current = next;
      clientRef.current?.send({
        type: "state",
        room,
        from: selfIdRef.current,
        payload: next,
      });
    },
    [room],
  );

  const toggleAudio = useCallback(() => {
    const track = cameraStreamRef.current?.getAudioTracks()[0];
    const next = !audioEnabled;
    if (track) track.enabled = next;
    setAudioEnabled(next);
    broadcastState({ audio: next, video: videoEnabled });
  }, [audioEnabled, videoEnabled, broadcastState]);

  const toggleVideo = useCallback(() => {
    // Apply to whichever video is currently being sent (camera or screen share).
    const track =
      screenStreamRef.current?.getVideoTracks()[0] ??
      cameraStreamRef.current?.getVideoTracks()[0];
    const next = !videoEnabled;
    if (track) track.enabled = next;
    setVideoEnabled(next);
    broadcastState({ audio: audioEnabled, video: next });
  }, [audioEnabled, videoEnabled, broadcastState]);

  const sendReaction = useCallback(
    (emoji: string) => {
      clientRef.current?.send({
        type: "reaction",
        room,
        from: selfIdRef.current,
        payload: emoji,
      });
      showReaction(emoji); // show our own reaction locally too
    },
    [room, showReaction],
  );

  const toggleHand = useCallback(() => {
    const next = !handRaised;
    setHandRaised(next);
    handRaisedRef.current = next;
    clientRef.current?.send({
      type: "hand",
      room,
      from: selfIdRef.current,
      payload: next,
    });
  }, [handRaised, room]);

  const isHost = roomState.host === selfIdRef.current;

  /**
   * Which side panels exist right now. Drives the tab bar, so it never offers a
   * tab for a panel that is not rendered — a tab that switches to nothing reads
   * as a broken app.
   */
  const sidebarPanels = useMemo(() => {
    const panels: { id: SidebarTab; label: string }[] = [];
    if (status === "in-room") panels.push({ id: "members", label: "成員" });
    if (status === "in-room" && agendaAvailable) {
      panels.push({ id: "agenda", label: "議程" });
    }
    if (status === "in-room" && captionConfig?.recording) {
      panels.push({ id: "transcript", label: "逐字稿" });
    }
    if (status === "in-room" && meetings.length > 0) {
      panels.push({ id: "meetings", label: "紀錄" });
    }
    if (status === "in-room" && recordings.length > 0) {
      panels.push({ id: "recordings", label: "錄影" });
    }
    if (status === "in-room") panels.push({ id: "search", label: "搜尋" });
    if (status === "in-room" && fileSharingAvailable)
      panels.push({ id: "files", label: "檔案" });
    panels.push({ id: "chat", label: "聊天" });
    return panels;
  }, [
    status,
    recordings.length,
    fileSharingAvailable,
    agendaAvailable,
    meetings.length,
    captionConfig?.recording,
  ]);

  /**
   * Which recognition locale the chosen track speaks.
   *
   * <p>From the server rather than hardcoded: `cmn-Hant-TW` is what Chrome wants
   * for Taiwanese Mandarin, and which variety a deployment recognises is its
   * decision, not the browser's.
   */
  const recognitionLang =
    captionConfig?.languages.find((l) => l.track === captionLang)
      ?.recognition ?? (captionLang === "zh" ? "cmn-Hant-TW" : "en-US");

  /**
   * Sends one line of recognition to the room.
   *
   * <p>The speaker's own line is rendered here rather than waiting for it to
   * come back: it is already on their screen before the socket has finished
   * carrying it, which is the difference between a subtitle and a delay. The
   * server's echo of the final line arrives afterwards carrying the id, and
   * `applyCaption` merges the two rather than showing them both.
   */
  const sendCaption = useCallback(
    (chunk: { text: string; final: boolean }) => {
      const payload: CaptionPayload = {
        text: chunk.text,
        lang: recognitionLang,
        final: chunk.final,
        spokenAt: Date.now(),
      };
      clientRef.current?.send({
        type: "caption",
        room,
        from: selfIdRef.current,
        payload,
      });
      setSubtitles((lines) =>
        applyCaption(
          lines,
          {
            peerId: selfIdRef.current,
            speaker: `${name.trim() || "你"}(你)`,
            text: chunk.text,
            lang: recognitionLang,
            final: chunk.final,
          },
          Date.now(),
        ),
      );
    },
    [room, name, recognitionLang],
  );

  const { error: captionError, supported: captionsSupported } =
    useSpeechCaptions({
      enabled: captionsOn && status === "in-room",
      lang: recognitionLang,
      onChunk: sendCaption,
    });

  /**
   * Refreshes the meeting list when a panel that reads it is opened.
   *
   * <p>The list is also fetched on join, and that fetch races the join itself:
   * the meeting row is opened by the server when this very participant arrives,
   * so the first person into a room could get an empty list and keep it for the
   * whole meeting — no 紀錄 tab, and a 產生摘要 button disabled because there was
   * no meeting to summarise. Reading it when somebody actually looks is both the
   * fix and what a person expects a panel to do.
   */
  useEffect(() => {
    if (status !== "in-room") return;
    if (sidebarTab !== "transcript" && sidebarTab !== "meetings") return;
    void loadMeetings(room);
  }, [status, sidebarTab, room, loadMeetings]);

  /**
   * Ages lines off the subtitle track.
   *
   * <p>A tick rather than a timer per line. Lines expire on a clock nobody is
   * otherwise driving — the last speaker's sentence has to disappear on its own
   * — and one interval that prunes is far less machinery than a timeout chasing
   * each line. It runs only while there is something on screen.
   */
  useEffect(() => {
    if (subtitles.length === 0) return;
    const timer = setInterval(
      () => setSubtitles((lines) => prune(lines, Date.now())),
      1000,
    );
    return () => clearInterval(timer);
  }, [subtitles.length]);

  const shownSubtitles = useMemo(
    () => visible(subtitles, Date.now()),
    // The tick above rewrites `subtitles` when anything expires, so this
    // recomputes then too — no separate clock needed here.
    [subtitles],
  );

  /**
   * Builds the media room for a transport.
   *
   * <p>Both transports take the same signaling client, the same local stream and
   * the same event sink, which is what makes swapping one for the other a
   * possibility rather than a rewrite: only the media plane changes, and chat,
   * notes, the agenda and the captions never notice.
   */
  const buildMediaRoom = useCallback(
    async (
      mode: "mesh" | "sfu",
      client: SignalingClient,
      stream: MediaStream,
      events: WebRtcRoomEvents,
      roomName: string,
      displayName: string,
    ): Promise<MediaRoom> => {
      const config = mediaConfigRef.current;
      if (mode === "sfu") {
        const lkToken = await fetchMediaToken(
          roomName,
          selfIdRef.current,
          displayName,
          token,
        );
        return new SfuRoom(client, selfIdRef.current, stream, events, {
          url: resolveLivekitUrl(config?.livekitUrl ?? ""),
          token: lkToken,
        });
      }
      return new WebRtcRoom(
        client,
        selfIdRef.current,
        stream,
        events,
        config?.iceServers?.length ? config.iceServers : undefined,
      );
    },
    [token],
  );

  /**
   * Moves this participant onto the transport the room has switched to.
   *
   * <p>The room grew past what a mesh can carry and the server said so. What
   * happens here is a teardown and a rebuild of the media plane only — the
   * signaling socket stays up throughout, so membership, chat, the shared notes
   * and the captions all continue across the switch. What people see is their
   * video tiles blink; what they do not see is a reconnect.
   *
   * <p>The local stream is deliberately reused rather than reacquired. Asking
   * getUserMedia again mid-meeting risks a second permission prompt and, on some
   * platforms, a device that is briefly busy — for a change nobody asked for.
   */
  const switchTransport = useCallback(
    async (mode: "mesh" | "sfu") => {
      const client = clientRef.current;
      const stream = cameraStreamRef.current ?? screenStreamRef.current;
      const events = mediaEventsRef.current;
      const joined = joinedAsRef.current;
      if (!client || !stream || !events || !joined) return;

      try {
        // Refetched, because the SFU half of the config — the LiveKit URL — is
        // only populated where an SFU exists, and a room that started on the
        // mesh may have been told nothing about it.
        mediaConfigRef.current = await fetchMediaConfig(token, joined.room);
        roomRef.current?.leave(joined.room);
        // Remote tiles belong to the old transport. Left in place they would
        // hang as frozen frames until each peer happened to republish.
        setRemoteStreams(new Map());
        const next = await buildMediaRoom(
          mode,
          client,
          stream,
          events,
          joined.room,
          joined.displayName,
        );
        roomRef.current = next;
        next.join(joined.room, joined.displayName);
        applyMediaMode(mode);
      } catch (e) {
        setError(
          e instanceof Error
            ? `切換視訊傳輸失敗:${e.message}`
            : "切換視訊傳輸失敗",
        );
      }
    },
    [token, buildMediaRoom],
  );

  /**
   * Puts one line through the agenda's own capture grammar.
   *
   * <p>An action item lifted out of a summary is exactly what somebody would
   * have typed into the capture line, so it is parsed the same way rather than
   * posted straight to the API — the `@owner` reaches the to-do list by the one
   * path that has always handled owners, and nothing new can disagree with it.
   */
  const addCapturedLine = useCallback(
    (line: string) => {
      const captured = parseCapture(line);
      if (!captured.text.trim()) return;
      void addAgendaItem(captured);
    },
    [addAgendaItem],
  );

  /** Host only: lock or unlock the room to newcomers (server re-validates). */
  const toggleLock = useCallback(() => {
    clientRef.current?.send({
      type: "lock",
      room,
      from: selfIdRef.current,
      payload: !roomState.locked,
    });
  }, [room, roomState.locked]);

  /** Host only: remove a participant (server re-validates and closes their socket). */
  const kickPeer = useCallback(
    (peerId: string) => {
      clientRef.current?.send({
        type: "kick",
        room,
        from: selfIdRef.current,
        to: peerId,
      });
    },
    [room],
  );

  const stopScreenShare = useCallback(() => {
    const camera = cameraStreamRef.current;
    if (roomRef.current && camera?.getVideoTracks()[0]) {
      void roomRef.current.replaceVideoTrack(camera.getVideoTracks()[0]);
    }
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    setLocalStream(camera);
    setScreenSharing(false);
  }, []);

  const startScreenShare = useCallback(async () => {
    try {
      const screen = await navigator.mediaDevices.getDisplayMedia({
        video: true,
      });
      const screenTrack = screen.getVideoTracks()[0];
      if (!screenTrack || !roomRef.current) return;
      await roomRef.current.replaceVideoTrack(screenTrack);
      screenStreamRef.current = screen;
      setLocalStream(screen);
      setScreenSharing(true);
      // The browser's own "stop sharing" control ends the track — revert when it does.
      screenTrack.onended = () => stopScreenShare();
    } catch (e) {
      // getDisplayMedia rejects if the user cancels the picker; that is not an error.
      if (e instanceof DOMException && e.name === "NotAllowedError") return;
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [stopScreenShare]);

  /** Starts/stops a server-side LiveKit Egress recording (SFU mode only). */
  const toggleRecording = useCallback(async () => {
    const headers = authHeaders();
    try {
      if (recordingId) {
        await fetch(
          `/api/media/recordings/stop?egressId=${encodeURIComponent(recordingId)}`,
          {
            method: "POST",
            headers,
          },
        );
        recordingIdRef.current = null;
        setRecordingId(null);
        // Egress uploads after the stop call, so give it a moment to land.
        setTimeout(() => void loadRecordings(room), 4000);
        return;
      }
      const res = await fetch(
        `/api/media/recordings/${encodeURIComponent(room)}/start`,
        {
          method: "POST",
          headers,
        },
      );
      if (!res.ok) throw new Error(`錄影啟動失敗(HTTP ${res.status})`);
      const { egressId } = (await res.json()) as { egressId: string };
      recordingIdRef.current = egressId;
      setRecordingId(egressId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [recordingId, room, token, loadRecordings]);

  const sendChat = useCallback(
    (text: string) => {
      clientRef.current?.send({
        type: "chat",
        room,
        from: selfIdRef.current,
        payload: text,
      });
      // The server broadcasts only to others, so echo our own message locally.
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          fromId: selfIdRef.current,
          text,
          mine: true,
        },
      ]);
    },
    [room],
  );

  return (
    <main className="app">
      <header className="app__header">
        <div className="app__masthead">
          <h1>WarRoomLive</h1>
          <ThemeToggle
            theme={theme}
            preference={themePreference}
            onChange={setThemePreference}
          />
        </div>
        <p className="app__subtitle">低延遲跨部門協作討論室</p>
      </header>

      <section className="app__controls">
        <label>
          你的名稱
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="輸入顯示名稱"
            disabled={status === "in-room" || status === "connecting"}
          />
        </label>
        <label>
          房間名稱
          <input
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            disabled={status === "in-room" || status === "connecting"}
          />
        </label>
        {status === "in-room" ? (
          <>
            <button className="btn-secondary" onClick={toggleAudio}>
              {audioEnabled ? "靜音" : "取消靜音"}
            </button>
            <button className="btn-secondary" onClick={toggleVideo}>
              {videoEnabled ? "關閉視訊" : "開啟視訊"}
            </button>
            <button
              className="btn-secondary"
              onClick={screenSharing ? stopScreenShare : startScreenShare}
            >
              {screenSharing ? "停止分享" : "分享螢幕"}
            </button>
            {mediaMode === "sfu" && (
              <button
                className="btn-secondary"
                onClick={() => void toggleRecording()}
              >
                {recordingId ? "🔴 停止錄影" : "錄影"}
              </button>
            )}
            {/* Offered only where it could work. Speech recognition is a
                Chrome-family API, and a button that silently does nothing is
                worse than a button that is not there. */}
            {captionsSupported && (
              <span className="caption-control">
                <button
                  className="btn-secondary"
                  aria-pressed={captionsOn}
                  onClick={() => setCaptionsOn((on) => !on)}
                >
                  {captionsOn ? "💬 關閉字幕" : "💬 開啟字幕"}
                </button>
                <label className="caption-control__lang">
                  <span className="visually-hidden">你說話的語言</span>
                  <select
                    title="你說話的語言(字幕中英文都會顯示)"
                    value={captionLang}
                    onChange={(e) =>
                      setCaptionLang(e.target.value as "zh" | "en")
                    }
                  >
                    {(
                      captionConfig?.languages ?? [
                        {
                          track: "zh" as const,
                          label: "中文",
                          recognition: "",
                        },
                        {
                          track: "en" as const,
                          label: "English",
                          recognition: "",
                        },
                      ]
                    ).map((lang) => (
                      <option key={lang.track} value={lang.track}>
                        {lang.label}
                      </option>
                    ))}
                  </select>
                </label>
                {/* Beside the control that caused it. A permission refusal shown
                    as a page-level error reads as the room being broken. */}
                {captionError && (
                  <span className="caption-control__error" role="alert">
                    {captionError}
                  </span>
                )}
              </span>
            )}
            {isHost && (
              <button className="btn-secondary" onClick={toggleLock}>
                {roomState.locked ? "🔓 解除鎖定" : "🔒 鎖定房間"}
              </button>
            )}
            <button onClick={leave}>離開房間</button>
          </>
        ) : (
          <button
            onClick={join}
            disabled={status === "connecting" || !room.trim()}
          >
            {status === "connecting" ? "連線中…" : "加入房間"}
          </button>
        )}
      </section>

      {error && <p className="app__error">⚠️ {error}</p>}

      {status === "in-room" && connection === "reconnecting" && (
        <p className="app__reconnecting">
          🔌 與伺服器的連線中斷,正在自動重新連線…(共享筆記與白板不受影響)
        </p>
      )}

      {status === "in-room" &&
        mediaMode === "mesh" &&
        members.length >= ROOM_WARN_THRESHOLD && (
          <p className="app__warning">
            ⚠️ 房間目前 {members.length} 人。此版本採 WebRTC full
            mesh,人數偏多時上行頻寬與畫面可能開始卡頓(上限 8 人)。
          </p>
        )}

      {/* Something's time has come. `assertive` because it is the one thing on
          this page that arrives without anybody having acted — a polite region
          would wait for a pause that a live meeting never has. It stays until
          dismissed: a nudge that fades is one the person who looked away
          never saw. */}
      {due.length > 0 && (
        <div className="due" role="alert" aria-live="assertive">
          <span className="due__label">時間到</span>
          <ul className="due__list">
            {due.map((item) => (
              <li key={`${item.kind}:${item.id}`} className="due__item">
                {item.text}
                {item.assignee && (
                  <span className="chip chip--who">@{item.assignee}</span>
                )}
              </li>
            ))}
          </ul>
          <button
            className="due__dismiss"
            onClick={() => setDue([])}
            aria-label="知道了,關閉提醒"
          >
            知道了
          </button>
        </div>
      )}

      {status === "in-room" && (
        <ReactionBar
          onReact={sendReaction}
          handRaised={handRaised}
          onToggleHand={toggleHand}
        />
      )}

      {status === "in-room" && (
        <RoomAnnouncer names={members.map((m) => m.name)} />
      )}

      <section
        className="workspace"
        ref={workspaceRef}
        style={
          {
            "--sidebar-width": `${sidebarWidth}px`,
            "--tile-min": `${tileSize}px`,
          } as CSSProperties
        }
      >
        <div className="stage">
          {/* Belongs to the video, not to the room controls: it changes what
              this screen shows, not what anyone else sees. */}
          {status === "in-room" && (
            <div className="zoom" role="group" aria-label="視訊大小">
              <button
                className="zoom__btn"
                aria-label="縮小視訊"
                disabled={tileSize === TILE_STEPS[0]}
                onClick={() => resizeTiles(-1)}
              >
                −
              </button>
              <span className="zoom__level tabular" aria-hidden="true">
                {TILE_STEPS.indexOf(tileSize as (typeof TILE_STEPS)[number]) +
                  1}
                /{TILE_STEPS.length}
              </span>
              <button
                className="zoom__btn"
                aria-label="放大視訊"
                disabled={tileSize === TILE_STEPS[TILE_STEPS.length - 1]}
                onClick={() => resizeTiles(1)}
              >
                +
              </button>
            </div>
          )}
          <div className="video-area">
            <div className="video-grid">
              {localStream && (
                <VideoTile
                  label={`${name.trim() || "你"}(你${screenSharing ? "・分享中" : ""})`}
                  stream={localStream}
                  muted
                  audioOff={!audioEnabled}
                  videoOff={!videoEnabled && !screenSharing}
                  handRaised={handRaised}
                />
              )}
              {[...remoteStreams].map(([peerId, stream]) => (
                <VideoTile
                  key={peerId}
                  label={nameOf(peerId)}
                  stream={stream}
                  audioOff={peerStates.get(peerId)?.audio === false}
                  videoOff={peerStates.get(peerId)?.video === false}
                  handRaised={raisedHands.has(peerId)}
                />
              ))}
            </div>
            {/* With the video, not beside it: a subtitle is read while looking at
              the person speaking, and a sidebar panel would make that a choice. */}
            {status === "in-room" && (
              <CaptionOverlay lines={shownSubtitles} />
            )}
          </div>
        </div>
        <WorkspaceDivider
          width={sidebarWidth}
          onChange={resizeSidebar}
          available={workspaceRef.current?.clientWidth ?? Infinity}
        />
        <div className="sidebar" data-active={sidebarTab}>
          {/* Shown at every width. Seven panels stacked in a 320px rail give
              each a sliver and none of them enough room to be read — on a
              desktop as much as on a phone — so one is open at a time and this
              chooses which. */}
          <SidebarTabs
            tabs={sidebarPanels}
            active={sidebarTab}
            onSelect={setSidebarTab}
          />
          {status === "in-room" && (
            <div
              className="sidebar__panel"
              data-panel="members"
              id="panel-members"
              role="tabpanel"
              aria-labelledby="tab-members"
              hidden={sidebarTab !== "members"}
            >
              <MemberList
                members={members}
                hostId={roomState.host}
                locked={roomState.locked}
                canKick={isHost}
                onKick={kickPeer}
              />
            </div>
          )}
          {status === "in-room" && agendaAvailable && (
            <div
              className="sidebar__panel"
              data-panel="agenda"
              id="panel-agenda"
              role="tabpanel"
              aria-labelledby="tab-agenda"
              hidden={sidebarTab !== "agenda"}
            >
              <AgendaPanel
                todos={todos}
                events={calendar}
                members={members.map((m) => m.name)}
                onAdd={addAgendaItem}
                onTriage={setAgendaTriage}
                onDelete={deleteAgendaItem}
              />
            </div>
          )}
          {status === "in-room" && captionConfig?.recording && (
            <div
              className="sidebar__panel"
              data-panel="transcript"
              id="panel-transcript"
              role="tabpanel"
              aria-labelledby="tab-transcript"
              hidden={sidebarTab !== "transcript"}
            >
              <TranscriptPanel
                lines={transcript}
                meetings={meetings}
                summary={summary}
                canSummarize={captionConfig.summary}
                onSummarize={summarizeMeeting}
                onAddTask={addCapturedLine}
              />
            </div>
          )}
          {status === "in-room" && meetings.length > 0 && (
            <div
              className="sidebar__panel"
              data-panel="meetings"
              id="panel-meetings"
              role="tabpanel"
              aria-labelledby="tab-meetings"
              hidden={sidebarTab !== "meetings"}
            >
              <MeetingsPanel meetings={meetings} onExport={exportMeeting} />
            </div>
          )}
          {status === "in-room" && recordings.length > 0 && (
            <div
              className="sidebar__panel"
              data-panel="recordings"
              id="panel-recordings"
              role="tabpanel"
              aria-labelledby="tab-recordings"
              hidden={sidebarTab !== "recordings"}
            >
              <RecordingsPanel
                recordings={recordings}
                onRequestUrl={recordingUrl}
                onDelete={deleteRecording}
              />
            </div>
          )}
          {status === "in-room" && (
            <div
              className="sidebar__panel"
              data-panel="search"
              id="panel-search"
              role="tabpanel"
              aria-labelledby="tab-search"
              hidden={sidebarTab !== "search"}
            >
              <SearchPanel onSearch={searchMessages} />
            </div>
          )}
          {status === "in-room" && fileSharingAvailable && (
            <div
              className="sidebar__panel"
              data-panel="files"
              id="panel-files"
              role="tabpanel"
              aria-labelledby="tab-files"
              hidden={sidebarTab !== "files"}
            >
              <FilesPanel
                files={files}
                onUpload={uploadFile}
                onRequestUrl={fileUrl}
                onDelete={deleteFile}
              />
            </div>
          )}
          <div
            className="sidebar__panel"
            data-panel="chat"
            id="panel-chat"
            role="tabpanel"
            aria-labelledby="tab-chat"
            hidden={sidebarTab !== "chat"}
          >
            <ChatPanel
              messages={messages.map((m) => ({
                id: m.id,
                from: m.mine ? "你" : (m.name ?? nameOf(m.fromId)),
                text: m.text,
                mine: m.mine,
              }))}
              onSend={sendChat}
              disabled={status !== "in-room" || connection !== "open"}
            />
          </div>
        </div>
      </section>

      {status === "in-room" && (
        <CollabPanel
          room={room}
          userName={name.trim() || `訪客-${selfIdRef.current.slice(0, 4)}`}
          token={token}
        />
      )}

      <FloatingReactions reactions={reactions} />
    </main>
  );
}
