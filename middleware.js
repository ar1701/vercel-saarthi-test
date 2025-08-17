module.exports.isLoggedIn = (req, res, next) => {
  // If we're in maintenance mode or database isn't available, show a special page
  if (process.env.MAINTENANCE_MODE === 'true' || 
      (req.app.get('dbStatus') === false && process.env.NODE_ENV === 'production')) {
    return res.redirect('/_debug');
  }

  if (!req.isAuthenticated()) {
    req.session.redirectUrl = req.originalUrl;
    req.flash("error", "You must be logged in to access this page");
    return res.redirect("/login");
  }
  next();
};
