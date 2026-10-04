package com.example;

import org.springframework.web.bind.annotation.*;
import org.springframework.jdbc.core.JdbcTemplate;

@RestController
@RequestMapping("/api")
public class OrderController {
    private final JdbcTemplate jdbc;

    public OrderController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    @GetMapping("/orders")
    public Map<String, Object> one(@RequestParam String id) {
        int key = Integer.parseInt(id);
        return jdbc.queryForMap("SELECT * FROM orders WHERE id = " + key);
    }

}
