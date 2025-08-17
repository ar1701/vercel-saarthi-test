module.exports.isLoggedIn = (req, res, next) => {
  console.log("[isLoggedIn] Check for", req.path);
  console.log("- isAuthenticated:", req.isAuthenticated());
  console.log("- Session:", !!req.session);
  console.log("- dbStatus:", req.app.get("dbStatus"));

  // If we're in maintenance mode or database isn't available, show a special page
  if (
    process.env.MAINTENANCE_MODE === "true" ||
    (req.app.get("dbStatus") === false && process.env.NODE_ENV === "production")
  ) {
    console.log(
      "- Redirecting to debug page due to maintenance mode or DB unavailability"
    );
    return res.redirect("/_debug");
  }

  // Allow bypass in development mode with BYPASS_AUTH=true
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.BYPASS_AUTH === "true"
  ) {
    console.log("- Auth bypassed in development mode");
    return next();
  }

  if (!req.isAuthenticated()) {
    console.log("- Not authenticated, redirecting to login");
    req.session.redirectUrl = req.originalUrl;
    req.flash("error", "You must be logged in to access this page");
    return res.redirect("/login");
  }

  console.log("- Authentication passed");
  next();
};
