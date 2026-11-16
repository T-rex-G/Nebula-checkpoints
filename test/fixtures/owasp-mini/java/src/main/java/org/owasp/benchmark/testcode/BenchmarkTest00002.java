package org.owasp.benchmark.testcode;

import java.io.IOException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class BenchmarkTest00002 extends HttpServlet {
    @Override
    public void doPost(HttpServletRequest request, HttpServletResponse response) throws IOException {
        String name = request.getParameter("name");
        java.sql.PreparedStatement statement = org.owasp.benchmark.helpers.Store.prepare("SELECT * FROM users WHERE name = ?");
        statement.setString(1, name);
        statement.executeQuery();
    }
}
