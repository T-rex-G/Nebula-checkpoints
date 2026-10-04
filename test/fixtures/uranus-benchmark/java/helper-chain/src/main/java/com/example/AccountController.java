package com.example;

import org.springframework.web.bind.annotation.*;
import org.springframework.jdbc.core.JdbcTemplate;

@RestController
@RequestMapping("/api")
public class AccountController {
    private final JdbcTemplate jdbc;

    public AccountController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/accounts")
    public List<Map<String, Object>> search(@RequestParam String owner) {
        return lookup(owner);
    }

    private List<Map<String, Object>> lookup(String owner) {
        String query = "SELECT * FROM accounts WHERE owner = '" + owner + "'";
        return run(query);
    }

    private List<Map<String, Object>> run(String query) {
        return jdbc.queryForList(query); // expect: SEC-001
    }

}
