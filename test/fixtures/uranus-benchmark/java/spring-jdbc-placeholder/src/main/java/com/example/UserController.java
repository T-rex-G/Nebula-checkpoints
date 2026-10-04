package com.example;

import org.springframework.web.bind.annotation.*;
import org.springframework.jdbc.core.JdbcTemplate;

@RestController
@RequestMapping("/api")
public class UserController {
    private final JdbcTemplate jdbc;

    public UserController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/users")
    public List<Map<String, Object>> find(@RequestParam String name) {
        return jdbc.queryForList("SELECT * FROM users WHERE name = ?", name);
    }

}
