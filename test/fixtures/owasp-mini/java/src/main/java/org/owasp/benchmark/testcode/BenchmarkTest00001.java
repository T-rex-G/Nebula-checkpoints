package org.owasp.benchmark.testcode;

import java.io.IOException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class BenchmarkTest00001 extends HttpServlet {
    @Override
    public void doPost(HttpServletRequest request, HttpServletResponse response) throws IOException {
        String name = request.getParameter("name");
        java.sql.Statement statement = org.owasp.benchmark.helpers.Store.statement();
        statement.executeQuery("SELECT * FROM users WHERE name = '" + name + "'");
    }
}
