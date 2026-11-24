package app;

import java.io.IOException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class Search extends HttpServlet {
    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
        String order = "name";
        if (request.getParameter("custom") != null) order = request.getParameter("order");
        else if (request.getParameter("recent") != null) order = "created_at";
        else order = "name";
        java.sql.Statement statement = Db.statement();
        statement.executeQuery("SELECT * FROM items ORDER BY " + order); // expect: SEC-001 confirmed
    }
}
