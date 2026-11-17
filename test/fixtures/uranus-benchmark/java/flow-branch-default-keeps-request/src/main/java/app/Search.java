package app;

import java.io.IOException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class Search extends HttpServlet {
    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
        String term = request.getParameter("term");
        if (term == null) term = "";
        java.sql.Statement statement = Db.statement();
        statement.executeQuery("SELECT * FROM items WHERE name = '" + term + "'"); // expect: SEC-001 confirmed
    }
}
