package com.example;

import java.net.URLEncoder;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;
import org.apache.commons.text.StringEscapeUtils;

@RestController
public class SearchController {
    private final JdbcTemplate jdbc;

    public SearchController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/users")
    public Object users(@RequestParam String name) {
        String safe = StringEscapeUtils.escapeHtml4(name);
        return jdbc.queryForList("SELECT * FROM users WHERE name = '" + safe + "'"); // expect: SEC-001
    }
}
