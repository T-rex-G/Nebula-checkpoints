package com.example.service;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service
public class UserServiceImpl implements UserService {
    private final JdbcTemplate jdbcTemplate;

    public UserServiceImpl(JdbcTemplate jdbcTemplate) {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Override
    public List<User> findByName(String name) {
        return jdbcTemplate.query("SELECT * FROM users WHERE name = '" + name + "'", new UserMapper()); // expect: SEC-001
    }
}
