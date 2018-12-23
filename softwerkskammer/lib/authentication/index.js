/* eslint no-underscore-dangle: 0 */

const passport = require('passport');
const jwt = require('jsonwebtoken');
const MagicLinkStrategy = require('./magicLinkStrategy');

const logger = require('winston').loggers.get('authorization');

const conf = require('simple-configure');
const beans = conf.get('beans');
const authenticationService = beans.get('authenticationService');
const mailsenderService = beans.get('mailsenderService');
const memberstore = beans.get('memberstore');
const statusmessage = beans.get('statusmessage');
const misc = beans.get('misc');

const urlPrefix = conf.get('publicUrlPrefix');

function loginChoiceCookieFor(url) {
  const identifier = 'openid_identifier=';
  if (url.startsWith('/openidconnect?')) {
    return {oidc: true};
  }
  if (url.startsWith('/github?')) {
    return {gh: true};
  }
  if (url.startsWith('/openid?') && url.includes(identifier + 'https://openid.stackexchange.com')) {
    return {se: true};
  }
  if (url.startsWith('/openid?') && url.includes(identifier)) {
    const start = url.indexOf(identifier) + identifier.length;
    let end = url.indexOf('&', start);
    if (end < 0) { end = undefined; }
    return {provider: url.substring(start, end)};
  }
  return {};
}

function createProviderAuthenticationRoutes(app1, strategyName) {

  function setReturnOnSuccess(req, res, next) {
    if (req.session.returnTo === undefined) {
      req.session.returnTo = req.query.returnTo || '/';
    }
    res.cookie('loginChoice', loginChoiceCookieFor(decodeURIComponent(req.url)), {maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: true}); // expires: Date
    next();
  }

  function authenticate() {
    return passport.authenticate(strategyName, {successReturnToOrRedirect: '/', failureRedirect: '/login'});
  }

  app1.get('/' + strategyName, setReturnOnSuccess, authenticate());
  app1.get('/' + strategyName + '/callback', authenticate());

}

function setupOpenID(app1) {
  const OpenIDStrategy = require('passport-openid').Strategy;
  passport.use(new OpenIDStrategy(
    { // openID can always be used
      returnURL: urlPrefix + '/auth/openid/callback',
      realm: urlPrefix,
      profile: true,
      passReqToCallback: true
    },
    authenticationService.createUserObjectFromOpenID
  ));
  createProviderAuthenticationRoutes(app1, 'openid');
}

function setupGithub(app1) {
  const githubClientID = conf.get('githubClientID');
  if (githubClientID) {
    const GithubStrategy = require('passport-github').Strategy;
    const strategy = new GithubStrategy(
      {
        clientID: githubClientID,
        clientSecret: conf.get('githubClientSecret'),
        callbackURL: urlPrefix + '/auth/github/callback',
        customHeaders: {'User-Agent': 'agora node server'},
        passReqToCallback: true
      },
      authenticationService.createUserObjectFromGithub
    );
    strategy._oauth2.useAuthorizationHeaderforGET(true);
    passport.use(strategy);
    createProviderAuthenticationRoutes(app1, 'github');
  }
}

function setupGooglePlus(app1) {
  const googlePlusClientID = conf.get('googlePlusClientID');
  if (googlePlusClientID) {
    const GooglePlusStrategy = require('openidconnect-for-passport').Strategy;

    const strategy = new GooglePlusStrategy(
      {
        authorizationURL: 'https://accounts.google.com/o/oauth2/auth',
        tokenURL: 'https://www.googleapis.com/oauth2/v3/token',
        clientID: googlePlusClientID,
        clientSecret: conf.get('googlePlusClientSecret'),
        callbackURL: urlPrefix + '/auth/openidconnect/callback',
        userInfoURL: 'https://www.googleapis.com/plus/v1/people/me',

        scope: 'email profile',
        skipUserProfile: false,

        passReqToCallback: true
      },
      authenticationService.createUserObjectFromGooglePlus
    );
    strategy.authorizationParams = function () {
      return {
        'openid.realm': urlPrefix
      };
    };

    passport.use(strategy);
    createProviderAuthenticationRoutes(app1, strategy.name);
  }
}

function setupMagicLink(app1) {

  const strategy = new MagicLinkStrategy({
      secret: conf.get('magicLinkSecret'),
      tokenName: 'token',
      tokenProblemRedirect: '/' // 'tokenProblem.html'
    },
    authenticationService.createUserObjectFromMagicLink
  );

  passport.use(strategy);
  createProviderAuthenticationRoutes(app1, strategy.name);

  app1.get('/magiclinkmail', (req, res, next) => {
    const email = req.query.magic_link_email && req.query.magic_link_email.trim();
    if (!email) {

      statusmessage.errorMessage('Keine Mailadresse für Magic Link', 'Bitte gib die Mailadresse eines Softwerkskammer-Mitglieds an!').putIntoSession(req, res);
      return res.redirect('/');
    }

    memberstore.getMemberForEMail(email, (err, member) => {
      if (err) { return next(err); }
      if (!member) {
        statusmessage.errorMessage('Kein Mitglied', 'Wir konnten die angegebene Mailadresse nicht finden. Bitte gib eine in der Softwerkskammer hinterlegte Mailadresse an!').putIntoSession(req, res);
        return res.redirect('/');
      }

      jwt.sign({authenticationId: member.authentications()[0]}, conf.get('magicLinkSecret'), {expiresIn: '30 minutes'}, (err1, token) => {
        if (err1) { return next(err1); }

        mailsenderService.sendMagicLinkToMember(member, token, err2 => {
          if (err2) { return next(err2); }

          statusmessage.successMessage('Magic Link ist unterwegs', 'Wir haben Dir einen Magic Link geschickt. Er ist 30 Minuten lang gültig. Bitte prüfe auch Deinen Spamfolder, falls Du ihn nicht bekommst.').putIntoSession(req, res);
          return res.redirect('/');
        });
      });
    });
  });
}

function setupUserPass(app1) {
  const LocalStrategy = require('passport-local').Strategy;

  passport.use(new LocalStrategy(
    {usernameField: 'email', passwordField: 'password'},
    (email, password, done) => {
      const isNewUser = password === 'NEW';
      memberstore.getMemberForEMail(email, (err, member) => {
        if (err) {
          logger.error('Login error for: ' + email);
          logger.error(err);
          return done(err);
        }
        if (isNewUser) { // create new user for not alerady registerd email
          logger.info('NEW Login for: ' + email);
          if (member) {
            logger.error(new Error('Member with email address "' + email + '" already exists'));
            return done(null, false, {message: 'authentication.error_member_exists'});
          }
          const authenticationId = 'UserPass' + email;
          const profile = {emails: [{value: email}]};
          return done(null, {authenticationId, profile});
        } else { // login for existing user who already has setup a password
          logger.info('Login for: ' + email);
          if (!member) {
            logger.error(new Error('Member with email address "' + email + '" doesn\'t exist'));
            return done(null, false, {message: 'authentication.error_member_not_exists'});
          }
          if (member.passwordMatches(password)) {
            return done(null, {authenticationId: member.id(), member});
          }
          done(null, false);
        }
      });
    })
  );
  app1.post('/login', (req, res, next) => {
      passport.authenticate('local', (err, user, info) => {
        if (err) { return next(err); }
        if (info) { statusmessage.errorMessage('authentication.error', info.message).putIntoSession(req); }
        if (!user) { return res.redirect('/login'); }
        res.cookie('loginChoice', {userPass: true}, {maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: true}); // expires: Date
        req.logIn(user, {}, (err1) => {
          if (err1) { return next(err1); }
          let url = '/';
          if (req.session && req.session.returnTo) {
            url = req.session.returnTo;
            delete req.session.returnTo;
          }
          return res.redirect(url);
        });
      })(req, res, next);
    }
  );

}

const app = misc.expressAppIn(__dirname);

app.get('/logout', (req, res) => {
  req.logout();
  if (req.isAuthenticated && req.isAuthenticated()) {
    logger.info('Had to log out twice. IE problem?' + (req.user ? ' - User was: ' + req.user.authenticationId : ''));
    req.logout();
  }
  res.redirect('/goodbye.html');
});

setupOpenID(app);
setupGithub(app);
setupGooglePlus(app);
setupMagicLink(app);
setupUserPass(app);

module.exports = app;
