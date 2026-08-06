package com.warroomlive.web;

import org.springframework.context.annotation.Profile;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

/**
 * Full-text message search over the {@code message_search} read model, which the
 * indexer service builds from the event backbone — so results appear only when
 * the events overlay (broker + indexer) is running. Postgres FTS with an ILIKE
 * fallback (CJK text tokenizes poorly under 'simple'); the blueprint's
 * OpenSearch replaces this projection when search needs outgrow it.
 */
@RestController
@RequestMapping("/api/search")
@Profile("postgres")
public class SearchController {

    private static final int MAX_RESULTS = 50;

    private final JdbcTemplate jdbc;

    public SearchController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/messages")
    public List<Map<String, Object>> messages(
            @RequestParam String q,
            @RequestParam(required = false) String room) {
        String sql = """
                SELECT room, from_id, name, text, ts
                FROM message_search
                WHERE (tsv @@ plainto_tsquery('simple', ?) OR text ILIKE '%' || ? || '%')
                  AND (?::varchar IS NULL OR room = ?)
                ORDER BY ts DESC
                LIMIT ?
                """;
        return jdbc.query(sql, (rs, i) -> Map.of(
                        "room", rs.getString("room"),
                        "fromId", rs.getString("from_id"),
                        "name", rs.getString("name"),
                        "text", rs.getString("text"),
                        "ts", rs.getLong("ts")),
                q, q, room, room, MAX_RESULTS);
    }
}
