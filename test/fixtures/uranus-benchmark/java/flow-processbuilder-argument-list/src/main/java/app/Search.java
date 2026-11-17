package app;

import java.io.IOException;
import javax.servlet.http.HttpServlet;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;

public class Search extends HttpServlet {
    @Override
    protected void doGet(HttpServletRequest request, HttpServletResponse response) throws IOException {
        String host = request.getParameter("host");
        java.util.List<String> command = new java.util.ArrayList<String>();
        command.add("sh");
        command.add("-c");
        command.add("ping -c 1 " + host);
        ProcessBuilder builder = new ProcessBuilder();
        builder.command(command); // expect: SEC-011 confirmed
        builder.start();
    }
}
