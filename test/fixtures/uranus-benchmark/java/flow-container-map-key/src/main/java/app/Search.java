package app;

import java.io.IOException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class Search extends HttpServlet {
    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
        java.util.Map<String, String> fields = new java.util.HashMap<String, String>();
        fields.put("label", "Search");
        fields.put("term", request.getParameter("term"));
        java.sql.Statement statement = Db.statement();
        statement.executeQuery("SELECT * FROM items WHERE name = '" + fields.get("term") + "'"); // expect: SEC-001 confirmed
    }
}
