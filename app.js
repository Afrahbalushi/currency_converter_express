const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const Sequelize = require('sequelize');
const passport = require('passport');
const passportJWT = require('passport-jwt');
const jwt = require('jsonwebtoken');
const amqp = require('amqplib/callback_api');
const schedule = require('node-schedule');
const bcrypt = require('bcrypt');

const app = express();
app.use(bodyParser.json());

const sequelize = new Sequelize('currencyDB', 'sa', 'root', {
    host: 'localhost',
    dialect: 'mssql'
});

const Rate = sequelize.define('rate', {
    currency: Sequelize.STRING,
    rate: Sequelize.FLOAT,
}, {
    timestamps: true
});

const Conversion = sequelize.define('conversion', {
    fromCurrency: Sequelize.STRING,
    toCurrency: Sequelize.STRING,
    amount: Sequelize.FLOAT,
    convertedAmount: Sequelize.FLOAT,
}, {
    timestamps: true
});

const User = sequelize.define('user', {
    username: {
        type: Sequelize.STRING,
        unique: true,
        allowNull: false
    },
    password: {
        type: Sequelize.STRING,
        allowNull: false
    }
}, {
    timestamps: true
});

User.beforeCreate(async (user) => {
    const salt = await bcrypt.genSalt(10);
    user.password = await bcrypt.hash(user.password, salt);
});

Rate.belongsTo(User, { foreignKey: 'userId', as: 'user' });
Conversion.belongsTo(User, { foreignKey: 'userId', as: 'user' });

User.hasMany(Rate, { foreignKey: 'userId', as: 'rates' });
User.hasMany(Conversion, { foreignKey: 'userId', as: 'conversions' });

sequelize.sync();

const ExtractJwt = passportJWT.ExtractJwt;
const JwtStrategy = passportJWT.Strategy;

const jwtOptions = {
    jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
    secretOrKey: 'afrah'
};

const strategy = new JwtStrategy(jwtOptions, async (jwt_payload, next) => {
    try {
        const user = await User.findByPk(jwt_payload.id);

        if (user) {
            next(null, user);
        } else {
            next(null, false);
        }
    } catch (error) {
        next(error, false);
    }
});

passport.use(strategy);
app.use(passport.initialize());

const queue = 'rates_queue';

amqp.connect('amqp://localhost', (err, connection) => {
    if (err) throw err;
    connection.createChannel((err, channel) => {
        if (err) throw err;
        channel.assertQueue(queue, {
            durable: false
        });
    });
});

schedule.scheduleJob('*/3 * * * *', async () => {
    try {
        const users = await User.findAll();

        users.forEach(async (user) => {
            const response = await axios.get('https://v6.exchangerate-api.com/v6/8f723791cd9e77dcdbafab91/latest/OMR');
            const rates = response.data.conversion_rates;

            Object.keys(rates).forEach(async (currency) => {
                const existingRate = await Rate.findOne({ where: { currency, userId: user.id } });

                if (existingRate) {
                    existingRate.rate = rates[currency];
                    await existingRate.save();
                } else {
                    await Rate.create({
                        currency,
                        rate: rates[currency],
                        userId: user.id
                    });
                }
            });

            amqp.connect('amqp://localhost', (err, connection) => {
                if (err) throw err;
                connection.createChannel((err, channel) => {
                    if (err) throw err;
                    channel.sendToQueue(queue, Buffer.from(JSON.stringify(rates)));
                    if (queue !== null) {
                        console.log(`saved: ${queue}`);
                    }
                });
            });
        });
    } catch (error) {
        console.error(error);
    }
});




app.post('/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password are required' });
      }
    try {
        const user = await User.create({ username, password });
        res.json({ message: 'User registered successfully!' });
    } catch (error) {
        console.error(error);
        res.status(400).json({ error: 'Username already exists!' });
    }
});

app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const user = await User.findOne({ where: { username } });

        if (!user) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const isMatch = await bcrypt.compare(password, user.password);

        if (!isMatch) {
            return res.status(401).json({ error: 'Invalid username or password' });
        }

        const payload = { id: user.id };
        const token = jwt.sign(payload, jwtOptions.secretOrKey, { expiresIn: '1h' });

        res.json({ message: 'Login successful!', token });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Please fill username and password' });
    }
});

app.get('/rates', passport.authenticate('jwt', { session: false }), async (req, res) => {
    const { currencies } = req.query;
    if (!currencies) {
        return res.status(400).json({ error: 'Currencies query parameter is required' });
    }
    const currencyArray = currencies.split(',');

    try {
        const rates = await Rate.findAll({
            where: {
                currency: currencyArray,
                userId: req.user.id
            },
            order: [['updatedAt', 'ASC']]
        });
        res.json(rates);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error while retrieving rates' });
    }
});


app.post('/convert', passport.authenticate('jwt', { session: false }), async (req, res) => {
    const { fromCurrency, toCurrency, amount } = req.body;

    try {
        const fromRate = await Rate.findOne({
            where: { currency: fromCurrency, userId: req.user.id },
            order: [['updatedAt', 'DESC']]
        });

        const toRate = await Rate.findOne({
            where: { currency: toCurrency, userId: req.user.id },
            order: [['updatedAt', 'DESC']]
        });

        const convertedAmount = (amount / fromRate.rate) * toRate.rate;
        const conversion = await Conversion.create({
            fromCurrency,
            toCurrency,
            amount,
            convertedAmount,
            userId: req.user.id
        });

        res.json(conversion);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error while performing conversion' });
    }
});


app.get('/conversions', passport.authenticate('jwt', { session: false }), async (req, res) => {
    const { currencies } = req.query;
    if (!currencies) {
        return res.status(400).json({ error: 'Currencies query parameter is required' });
    }
    const currencyArray = currencies.split(',');

    try {
        const conversions = await Conversion.findAll({
            where: {
                userId: req.user.id,
                [Sequelize.Op.or]: [
                    { fromCurrency: currencyArray },
                    { toCurrency: currencyArray }
                ]
            },
            order: [['updatedAt', 'ASC']]
        });
        res.json(conversions);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Error while retrieving conversions' });
    }
});




const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
