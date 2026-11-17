package app;

import java.io.IOException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class Search extends HttpServlet {
    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
        String tag = "";
        java.util.Enumeration<String> tags = request.getHeaders("X-Tag");
        if (tags.hasMoreElements()) tag = tags.nextElement();
        java.sql.Statement statement = Db.statement();
        statement.executeQuery("SELECT * FROM items WHERE tag = '" + tag + "'"); // expect: SEC-001 confirmed
    }
}
