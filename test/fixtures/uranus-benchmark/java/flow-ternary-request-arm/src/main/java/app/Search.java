package app;

import java.io.IOException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class Search extends HttpServlet {
    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
        String raw = request.getParameter("term");
        String term = raw == null ? "" : raw.trim();
        java.sql.Statement statement = Db.statement();
        statement.executeQuery("SELECT * FROM items WHERE name = '" + term + "'"); // expect: SEC-001 confirmed
    }
}
