package app;

import java.io.IOException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class Search extends HttpServlet {
    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
        String order = request.getParameter("order");
        switch (order) {
            case "desc":
                order = "DESC";
                break;
            case "asc":
                order = "ASC";
                break;
        }
        java.sql.Statement statement = Db.statement();
        statement.executeQuery("SELECT * FROM items ORDER BY name " + order); // expect: SEC-001 confirmed
    }
}
