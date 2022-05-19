const express = require('express')
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
var nodemailer = require('nodemailer');
var sgTransport = require('nodemailer-sendgrid-transport');
require('dotenv').config();
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);


const app = express();
const jwt = require('jsonwebtoken');
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.pbyol.mongodb.net/myFirstDatabase?retryWrites=true&w=majority`;
const client = new MongoClient(uri, { useNewUrlParser: true, useUnifiedTopology: true, serverApi: ServerApiVersion.v1 });


function verifyJWT(req, res, next) {
  const authorization = req.headers.authorization;
  console.log(authorization);
  if (!authorization) {
    return res.status(401).send({ message: 'UnAuthorized access' });
  }
  const token = authorization.split(' ')[1];
  jwt.verify(token, process.env.ACCESS_TOKEN, function (err, decoded) {
    if (err) {
      return res.status(403).send({ message: 'Forbidden access' })
    }
    req.decoded = decoded;
    next();
  });


}

const emailSenderOption = {
  auth: {
    api_key: process.env.EMAIL_SENDER
  }
}

const emailSenderClient = nodemailer.createTransport(sgTransport(emailSenderOption));

function sendConfirmationEmail(booking) {
  const { patient, patientName, treatment, date, slot } = booking;
  var email = {
    from: process.env.EMAIL_SENDER_ADDRESS,
    to: patient,
    subject: `Appointment Booked for ${treatment} on ${date} at ${slot}`,
    text: `Appointment Booked for ${treatment} on ${date} at ${slot}`,
    html: `
    <div>
        <strong>Appointment Booked for ${treatment} on ${date} at ${slot}</strong>
    </div>
    <div>
    <p>“${treatment} is paid for their time, skill level, and the effort it took to get to that level.”

    Understanding the different factors that affect your treatment can help you determine how you stack up and where there's room to grow.
    
    This week on Doctors Portal, explore insights and uncover how to boost with international doctors</p>
    
    </div>
    `
  };

  emailSenderClient.sendMail(email, function (err, info) {
    if (err) {
      console.log(err);
    }
    else {
      console.log('Message sent: ', info);
    }
  });
}

async function run() {
  try {
    await client.connect();
    const serviceCollection = client.db("doctors_portal").collection("services");
    const bookingCollection = client.db("doctors_portal").collection("bookings");
    const userCollection = client.db("doctors_portal").collection("users");
    const doctorCollection = client.db("doctors_portal").collection("doctors");
    const paymentCollection = client.db('doctors_portal').collection('payments');


    const verifyAdmin = async (req, res, next) => {
      const initiator = req.decoded.email;
      const initiatorAcoount = await userCollection.findOne({ email: initiator });
      if (initiatorAcoount.role === 'admin') {
        next();
      }
      else {
        res.status(403).send({ message: 'Forbidden access' })
      }
    }




    app.post("/create-payment-intent", verifyJWT, async (req, res) => {
      const service = req.body;
      const price = service.price;
      const amount = price * 100;

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amount,
        currency: "eur",
        payment_method_types: [
          "card"
        ]
        
      });
      res.send({
        clientSecret: paymentIntent.client_secret,
      });

    })

    app.get('/service', async (req, res) => {
      const query = {};
      const cursor = serviceCollection.find(query).project({ name: 1 });
      const services = await cursor.toArray();
      res.send(services);
    })



    app.get('/available', async (req, res) => {
      const date = req.query.date || 'May 16, 2022';

      const services = await serviceCollection.find().toArray();

      const query = { date: date };
      const bookings = await bookingCollection.find(query).toArray();

      services.forEach(service => {
        const serviceBookings = bookings.filter(b => b.treatment === service.name);
        const booked = serviceBookings.map(s => s.slot);
        const available = service.slots.filter(s => !booked.includes(s));
        service.slots = available;

        /* 
        service.booked = booked; */
      })
      res.send(services)
    })

    app.get('/user', verifyJWT, async (req, res) => {

      const users = await userCollection.find().toArray();
      res.send(users);
    })




    app.get('/booking', verifyJWT, async (req, res) => {
      const patient = req.query.patient;
      const decodedEmail = req.decoded.email;
      if (patient === decodedEmail) {
        const query = { patient: patient };
        const bookings = await bookingCollection.find(query).toArray();
        return res.send(bookings)
      }
      else {
        return res.status(403).send({ message: 'Forbidden access' })
      }

    })

    app.get('/booking/:id',verifyJWT, async(req, res) =>{
      const id = req.params.id;
      const query = {_id: ObjectId(id)};
      const booking = await bookingCollection.findOne(query);

      res.send(booking);
    })

    app.get('/admin/:email', async (req, res) => {
      const email = req.params.email;
      const user = await userCollection.findOne({ email: email });
      const isAdmin = user.role === 'admin';
      res.send({ admin: isAdmin })
    });

    app.get('/doctor', verifyJWT, verifyAdmin, async (req, res) => {
      const doctors = await doctorCollection.find().toArray();

      res.send(doctors);
    })




    app.post('/booking', async (req, res) => {
      const booking = req.body;
      const query = { treatment: booking.treatment, date: booking.date, patient: booking.patient };
      const exist = await bookingCollection.findOne(query);
      if (exist) {
        return res.send({ successful: false, booking: exist })
      }
      const result = await bookingCollection.insertOne(booking);
      console.log('sending email')
      sendConfirmationEmail(booking);
      return res.send({
        success: true, result
      });

    })


    app.post('/doctor', verifyJWT, verifyAdmin, async (req, res) => {
      const doctor = req.body;
      console.log(doctor)
      const result = await doctorCollection.insertOne(doctor);

      res.send(result);
    })

    app.put('/user/:email', async (req, res) => {
      const email = req.params.email;
      const user = req.body;
      const filter = { email: email };
      const options = { upsert: true };

      const updateDoc = {
        $set: user,
      };

      const result = await userCollection.updateOne(filter, updateDoc, options);
      const token = jwt.sign({ email: email }, process.env.ACCESS_TOKEN, { expiresIn: '1h' });
      res.send({ result, token });

    })

    app.patch('/booking/:id', verifyJWT, async(req, res) =>{
      const id  = req.params.id;
      const payment = req.body;
      const filter = {_id: ObjectId(id)};
      const updatedDoc = {
        $set: {
          paid: true,
          transactionId: payment.transactionId
        }
      }
      const result = await paymentCollection.insertOne(payment);
      const updatedBooking = await bookingCollection.updateOne(filter, updatedDoc);
      res.send(updatedBooking);
    })


    app.put('/user/admin/:email', verifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const filter = { email: email };
      const updateDoc = {
        $set: { role: 'admin' },
      };
      const result = await userCollection.updateOne(filter, updateDoc);
      res.send(result);
    })

    app.delete('/doctor/:email', verifyJWT, verifyAdmin, async (req, res) => {
      const email = req.params.email;
      const query = { email: email };
      const result = await doctorCollection.deleteOne(query);

      res.send(result);
    })

  } finally {
    //await client.close();
  }
}
run().catch(console.dir);

app.get('/', (req, res) => {
  res.send('Hello From Doctors Portal')
})

app.listen(port, () => {
  console.log(`Doctor listening on port ${port}`)
})