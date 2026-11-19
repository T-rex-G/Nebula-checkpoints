package app;

import java.io.IOException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class Search extends HttpServlet {
    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
        String column = "name";
        java.util.Enumeration<String> names = request.getParameterNames();
        while (names.hasMoreElements()) {
            column = names.nextElement();
        }
        java.sql.Statement statement = Db.statement();
        statement.executeQuery("SELECT * FROM items ORDER BY " + column); // expect: SEC-001 to-confirm
    }
}
