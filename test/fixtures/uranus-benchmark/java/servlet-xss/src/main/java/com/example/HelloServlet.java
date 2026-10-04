package com.example;

import jakarta.servlet.http.HttpServlet;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;

public class HelloServlet extends HttpServlet {
    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws java.io.IOException {
        String name = request.getParameter("name");
        response.getWriter().write("<h1>Hello " + name + "</h1>"); // expect: SEC-033
    }
}
