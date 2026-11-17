package app;

import java.io.IOException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class Search extends HttpServlet {
    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
        String term = new Lookup().normalise(request.getParameter("term"));
        java.sql.Statement statement = Db.statement();
        statement.executeQuery("SELECT * FROM items WHERE name = '" + term + "'"); // expect: SEC-001 confirmed
    }
}

class Lookup {
    String normalise(String value) {
        return value.trim().toLowerCase();
    }
}
