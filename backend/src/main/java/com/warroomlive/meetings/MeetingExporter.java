package com.warroomlive.meetings;

import com.warroomlive.agenda.CalendarEventEntity;
import com.warroomlive.agenda.CalendarStore;
import com.warroomlive.agenda.TodoEntity;
import com.warroomlive.agenda.TodoStore;
import com.warroomlive.attachments.AttachmentEntity;
import com.warroomlive.attachments.AttachmentStore;
import com.warroomlive.chat.ChatRepository;
import com.warroomlive.chat.StoredMessage;
import com.warroomlive.recordings.RecordingEntity;
import com.warroomlive.recordings.RecordingStore;
import com.warroomlive.transcript.SummaryStore;
import com.warroomlive.transcript.TranscriptLineEntity;
import com.warroomlive.transcript.TranscriptStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;
import org.springframework.http.client.JdkClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

import java.net.URI;
import java.net.http.HttpClient;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.List;

/**
 * Everything a meeting left behind, as one Markdown document.
 *
 * <p>A war room accumulated chat, notes, a whiteboard, an agenda, files and a
 * recording, and then people closed the tab. Each part was durable and none of
 * it was reachable as "what happened in that meeting" — the record existed only
 * as the union of five places nobody visits together.
 *
 * <p>Markdown rather than PDF or HTML: it is the format that survives being
 * pasted into a ticket, an email and a wiki, which is what actually happens to
 * a meeting record.
 *
 * <p><strong>What is honest here.</strong> Chat, files and recordings are
 * windowed to the meeting, because they carry a time. The agenda is not: a task
 * created in one meeting and finished in the next belongs to both, so it is
 * exported as the room's current agenda and labelled as such. The notes are one
 * document per room rather than one per meeting, so they too are current rather
 * than historical, and the export says so rather than implying a snapshot it
 * does not have.
 */
@Component
@Profile("postgres")
public class MeetingExporter {

    private static final Logger log = LoggerFactory.getLogger(MeetingExporter.class);

    /** A meeting's chat, bounded. Longer than any real meeting, short of a DoS. */
    private static final int MAX_MESSAGES = 5000;
    private static final int MAX_ROWS = 500;
    private static final DateTimeFormatter STAMP =
            DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneOffset.UTC);
    private static final DateTimeFormatter CLOCK =
            DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneOffset.UTC);

    private final ChatRepository chat;
    private final ObjectProvider<TodoStore> todos;
    private final ObjectProvider<CalendarStore> calendar;
    private final ObjectProvider<AttachmentStore> attachments;
    private final ObjectProvider<RecordingStore> recordings;
    private final ObjectProvider<TranscriptStore> transcripts;
    private final ObjectProvider<SummaryStore> summaries;
    private final RestClient http;
    private final String collabUrl;

    public MeetingExporter(ChatRepository chat, ObjectProvider<TodoStore> todos,
            ObjectProvider<CalendarStore> calendar, ObjectProvider<AttachmentStore> attachments,
            ObjectProvider<RecordingStore> recordings,
            ObjectProvider<TranscriptStore> transcripts,
            ObjectProvider<SummaryStore> summaries,
            @Value("${warroomlive.collab.internal-url:http://collab:1234}") String collabUrl) {
        this.chat = chat;
        this.todos = todos;
        this.calendar = calendar;
        this.attachments = attachments;
        this.recordings = recordings;
        this.transcripts = transcripts;
        this.summaries = summaries;
        this.collabUrl = collabUrl;
        // HTTP/1.1, explicitly. Java's HttpClient defaults to offering an h2c
        // upgrade on plaintext, and the collab service is a WebSocket server:
        // its `ws` layer rejects any Upgrade header that does not say
        // "websocket" — with a 400, before the request ever reaches the export
        // handler. Nothing about the endpoint is wrong; the negotiation is.
        this.http = RestClient.builder()
                .requestFactory(new JdkClientHttpRequestFactory(
                        HttpClient.newBuilder().version(HttpClient.Version.HTTP_1_1).build()))
                .build();
    }

    public String export(MeetingEntity meeting, Instant end) {
        String room = meeting.room();
        StringBuilder out = new StringBuilder();

        out.append("# ").append(room).append(" — ").append(STAMP.format(meeting.startedAt()))
                .append(" UTC\n\n");
        out.append("- 開始:").append(STAMP.format(meeting.startedAt())).append(" UTC\n");
        if (meeting.endedAt() == null) {
            out.append("- 結束:*尚未結束*\n");
        } else {
            out.append("- 結束:").append(STAMP.format(meeting.endedAt())).append(" UTC\n");
            out.append("- 時長:").append(humanDuration(
                    Duration.between(meeting.startedAt(), meeting.endedAt()))).append('\n');
        }
        out.append("- 尖峰人數:").append(meeting.participantPeak()).append("\n\n");

        // Summary first, transcript last. The document is read by somebody who
        // was not there, and the order they need it in is conclusions, then
        // context, then — only if they are checking something — the words.
        appendSummary(out, meeting);
        appendChat(out, room, meeting.startedAt(), end);
        appendAgenda(out, room);
        appendNotes(out, room);
        appendAttachments(out, room, meeting.startedAt(), end);
        appendRecordings(out, room, meeting.startedAt(), end);
        appendTranscript(out, room, meeting.startedAt(), end);

        return out.toString();
    }

    /**
     * The summary, if one was ever made — never made here.
     *
     * <p>Exporting must not be able to spend money or call a model. Somebody
     * downloading a record expects a download, and a summary that appeared
     * because a document was exported would also mean two people exporting the
     * same meeting could get two different summaries of it.
     */
    private void appendSummary(StringBuilder out, MeetingEntity meeting) {
        SummaryStore store = summaries.getIfAvailable();
        if (store == null || meeting.id() == null) return;
        store.find(meeting.room(), meeting.id()).ifPresent(summary -> {
            out.append("## 重點摘要\n\n");
            out.append(summary.getSummaryMd().strip()).append("\n\n");
            // Attributed, and quietly. A summary is a model's reading of the
            // meeting, and the reader is entitled to know that before quoting it.
            out.append("> 由 ").append(summary.getModel()).append(" 從 ")
                    .append(summary.getLineCount()).append(" 句逐字稿產生於 ")
                    .append(STAMP.format(summary.getGeneratedAt())).append(" UTC。\n\n");
        });
    }

    /**
     * The transcript, windowed to the meeting like the chat is.
     *
     * <p>Both languages when both exist, the translation indented under the
     * original: the original is what was said and the translation is a reading
     * of it, and a record that presents them as equals loses which was which.
     */
    private void appendTranscript(StringBuilder out, String room, Instant from, Instant to) {
        TranscriptStore store = transcripts.getIfAvailable();
        if (store == null) return;
        List<TranscriptLineEntity> lines = store.window(room, from, to, MAX_MESSAGES);
        if (lines.isEmpty()) return;
        out.append("## 逐字稿\n\n");
        for (TranscriptLineEntity line : lines) {
            out.append("- `").append(CLOCK.format(line.getSpokenAt())).append("` **")
                    .append(line.getSpeaker()).append("**:")
                    .append(oneLine(line.getText())).append('\n');
            if (line.getTranslation() != null) {
                out.append("  - *").append(oneLine(line.getTranslation())).append("*\n");
            }
        }
        out.append('\n');
    }

    /** Windowed: a message carries its own time, so "during this meeting" is answerable. */
    private void appendChat(StringBuilder out, String room, Instant from, Instant to) {
        List<StoredMessage> all = chat.recent(room, MAX_MESSAGES);
        List<StoredMessage> during = all.stream()
                .filter(m -> {
                    Instant at = Instant.ofEpochMilli(m.ts());
                    return !at.isBefore(from) && !at.isAfter(to);
                })
                .toList();
        out.append("## 聊天\n\n");
        if (during.isEmpty()) {
            out.append("*這場會議沒有聊天記錄。*\n\n");
            return;
        }
        for (StoredMessage m : during) {
            out.append("- `").append(CLOCK.format(Instant.ofEpochMilli(m.ts()))).append("` **")
                    .append(m.name()).append("**:").append(oneLine(m.text())).append('\n');
        }
        out.append('\n');
    }

    /**
     * Not windowed, and labelled so.
     *
     * <p>A task raised in one meeting and closed in the next belongs to both,
     * and filtering by creation time would drop from the record the very item
     * the meeting was about closing.
     */
    private void appendAgenda(StringBuilder out, String room) {
        out.append("## 議程(房間目前狀態)\n\n");
        TodoStore todoStore = todos.getIfAvailable();
        CalendarStore calendarStore = calendar.getIfAvailable();
        boolean any = false;

        if (todoStore != null) {
            List<TodoEntity> items = todoStore.forRoom(room, MAX_ROWS, 0);
            for (TodoEntity t : items) {
                any = true;
                out.append("- [").append(t.isDone() ? "x" : " ").append("] ").append(t.getText());
                if (t.getAssignee() != null) out.append(" — @").append(t.getAssignee());
                if (t.getDueAt() != null) {
                    out.append(" (").append(STAMP.format(t.getDueAt())).append(" UTC)");
                }
                if (t.isDone() && t.getCompletedBy() != null) {
                    out.append(" ✓ ").append(t.getCompletedBy());
                }
                out.append('\n');
            }
        }
        if (calendarStore != null) {
            // From the epoch: the calendar endpoint reads forwards from now by
            // default, and a record of a meeting that hides what was scheduled
            // before it is not a record.
            List<CalendarEventEntity> events =
                    calendarStore.forRoom(room, Instant.EPOCH, MAX_ROWS, 0);
            for (CalendarEventEntity e : events) {
                any = true;
                out.append("- 📅 ").append(e.getTitle()).append(" — ")
                        .append(STAMP.format(e.getStartsAt())).append(" UTC");
                if (e.getEndsAt() != null) {
                    out.append("–").append(CLOCK.format(e.getEndsAt()));
                }
                if (e.isDone()) out.append(" ✓");
                out.append('\n');
            }
        }
        if (!any) out.append("*議程是空的。*\n");
        out.append('\n');
    }

    /**
     * The notes, fetched from the collab service because only it can decode Yjs.
     *
     * <p>A failure here must not lose the rest of the record: the export is
     * still worth having without the notes, and saying they could not be read
     * is better than a document that quietly omits them.
     */
    private void appendNotes(StringBuilder out, String room) {
        out.append("## 共同筆記(目前內容)\n\n");
        try {
            // URI.create, not the String overload: that one is a URI template
            // and would re-encode the % of an already-encoded name.
            String text = http.get()
                    .uri(URI.create(collabUrl + "/export/" + java.net.URLEncoder.encode(
                            "warroom:" + room, java.nio.charset.StandardCharsets.UTF_8)))
                    .retrieve()
                    .body(String.class);
            if (text == null || text.isBlank()) {
                out.append("*沒有筆記。*\n\n");
            } else {
                out.append(text.strip()).append("\n\n");
            }
        } catch (Exception e) {
            log.warn("Could not read notes for room {} from the collab service", room, e);
            out.append("*讀不到筆記(collab 服務沒有回應)。*\n\n");
        }
    }

    private void appendAttachments(StringBuilder out, String room, Instant from, Instant to) {
        AttachmentStore store = attachments.getIfAvailable();
        if (store == null) return;
        List<AttachmentEntity> during = store.forRoom(room, MAX_ROWS, 0).stream()
                .filter(a -> !a.getUploadedAt().isBefore(from) && !a.getUploadedAt().isAfter(to))
                .toList();
        if (during.isEmpty()) return;
        out.append("## 共享檔案\n\n");
        for (AttachmentEntity a : during) {
            out.append("- ").append(a.getFilename()).append(" (")
                    .append(a.getSizeBytes() / 1024).append(" KB, ")
                    .append(a.getUploadedBy()).append(")\n");
        }
        out.append('\n');
    }

    private void appendRecordings(StringBuilder out, String room, Instant from, Instant to) {
        RecordingStore store = recordings.getIfAvailable();
        if (store == null) return;
        List<RecordingEntity> during = store.forRoom(room, MAX_ROWS, 0).stream()
                .filter(r -> r.getStartedAt() != null
                        && !r.getStartedAt().isBefore(from) && !r.getStartedAt().isAfter(to))
                .toList();
        if (during.isEmpty()) return;
        out.append("## 錄影\n\n");
        for (RecordingEntity r : during) {
            // The id, not a URL: playback links are minted per request and
            // expire in half an hour, so one written into a document would be a
            // dead link by the time anybody read it.
            out.append("- 錄影 #").append(r.getId()).append(" — ")
                    .append(STAMP.format(r.getStartedAt())).append(" UTC")
                    .append("(在房間的錄影面板播放)\n");
        }
        out.append('\n');
    }

    /** A newline in a chat message would break the list item it sits in. */
    private static String oneLine(String text) {
        return text == null ? "" : text.replaceAll("\\s*\\R\\s*", " ↵ ");
    }

    static String humanDuration(Duration d) {
        long hours = d.toHours();
        long minutes = d.toMinutesPart();
        if (hours > 0) return hours + " 小時 " + minutes + " 分";
        if (minutes > 0) return minutes + " 分";
        return d.toSeconds() + " 秒";
    }
}
