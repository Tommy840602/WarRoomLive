package com.warroomlive.web;

import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

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

    private static final int DEFAULT_LIMIT = 50;
    private static final int MAX_LIMIT = 200;
    /**
     * The ILIKE branch scans, so query length is capped: a megabyte-long term
     * would be compared against every row in the projection.
     */
    private static final int MAX_QUERY_LENGTH = 200;

    private final JdbcTemplate jdbc;

    public SearchController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * @param limit  page size, clamped to {@value #MAX_LIMIT} — the caller may ask
     *               for less than the default but never for more than the server
     *               is willing to build
     * @param offset where the page starts; paging deep is the caller's cost, not
     *               an unbounded response
     */
    @GetMapping("/messages")
    public List<Map<String, Object>> messages(
            @RequestParam String q,
            @RequestParam(required = false) String room,
            @RequestParam(defaultValue = "" + DEFAULT_LIMIT) int limit,
            @RequestParam(defaultValue = "0") int offset) {
        if (q.length() > MAX_QUERY_LENGTH) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "query must be at most " + MAX_QUERY_LENGTH + " characters");
        }
        String sql = """
                SELECT room, from_id, name, text, ts
                FROM message_search
                WHERE (tsv @@ plainto_tsquery('simple', ?) OR text ILIKE '%' || ? || '%')
                  AND (?::varchar IS NULL OR room = ?)
                ORDER BY ts DESC
                LIMIT ? OFFSET ?
                """;
        return jdbc.query(sql, (rs, i) -> Map.of(
                        "room", rs.getString("room"),
                        "fromId", rs.getString("from_id"),
                        "name", rs.getString("name"),
                        "text", rs.getString("text"),
                        "ts", rs.getLong("ts")),
                q, q, room, room, Pages.limit(limit, DEFAULT_LIMIT, MAX_LIMIT), Pages.offset(offset));
    }
}
