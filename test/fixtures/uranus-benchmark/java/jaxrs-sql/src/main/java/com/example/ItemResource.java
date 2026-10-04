package com.example;

import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
import jakarta.ws.rs.QueryParam;
import java.sql.Connection;
import java.sql.Statement;

@Path("/items")
public class ItemResource {
    private Connection connection;

    @GET
    public String list(@QueryParam("category") String category) throws Exception {
        Statement statement = connection.createStatement();
        statement.executeQuery("SELECT * FROM items WHERE category = '" + category + "'"); // expect: SEC-001
        return "ok";
    }
}
